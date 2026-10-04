#!/usr/bin/env node
/**
 * npm run wf-sync — collect new n8n executions for every monitored workflow.
 *
 *   npm run wf-sync                  every monitored workflow
 *   npm run wf-sync -- <workflow id> just that one
 *   npm run wf-sync -- --full        ignore the cursor and re-walk the history
 *   npm run wf-sync -- --dry-run     fetch and report, write nothing
 *
 * Incremental by design. Each workflow stores the timestamp and id of the
 * newest execution it has seen; the next pass asks n8n for executions
 * `startedAfter` that and stops the moment a known id comes back. A workflow
 * with a year of history transfers nothing on a quiet pass.
 *
 * Two storage tiers, written to data/runs/<instance>__<workflow>.json:
 *
 *   rows     one per execution. Bounded by retention.rawDays and maxRows,
 *            because a workflow running every minute is 43,000 rows a month.
 *   buckets  hourly counters, kept far longer. These are what the long-range
 *            charts and the anomaly baselines read, so the history survives
 *            long after the individual rows have gone.
 *
 * One workflow failing is recorded against that workflow and the pass carries
 * on. The collector's own state — when it last ran, what failed, how slow n8n
 * was — goes into data/n8n-sync.json and onto the dashboard, because a monitor
 * that stops monitoring silently is worse than none.
 */

import path from 'node:path';
import fs from 'node:fs';

import {
  ROOT, abs, rel, readJson, writeJsonIfChanged, ensureDir, exists, listFiles, isJson,
} from '../lib/fsx.js';
import { scanDeep } from '../lib/redact.js';
import { resolveRegistry } from './registry.js';
import * as apiDriver from './client.js';
import * as sqliteDriver from './sqlite.js';
import { toRow, statusOf } from './volume.js';

/**
 * Which way this instance is read.
 *
 * Both drivers expose the same three functions and return the same shapes, so
 * everything below this line is identical whichever answers. `sqlite` reads
 * n8n's database over SSH and is what this estate uses — there is no public
 * API here. `api` remains for an n8n with no database to reach.
 */
const driverFor = (instance) => (instance.source === 'sqlite' ? sqliteDriver : apiDriver);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const full = args.includes('--full');
const only = args.filter((a) => !a.startsWith('--'));

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (color ? `[${c}m${s}[0m` : s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const dim = (s) => paint('2', s);

export const RUNS_DIR = ['data', 'runs'];

/* ------------------------------------------------------------- buckets */

const formatters = new Map();

/**
 * Which hour an execution belongs to, in the reporting timezone.
 *
 * Bucketing in UTC and shifting later does not work for this estate: IST is
 * +05:30, so UTC hours straddle two IST hours and "what happened between 2 and
 * 3pm" could never be answered exactly. Formatting in the target zone up front
 * costs nothing and is correct across DST and half-hour offsets alike.
 *
 * @returns {string|null} "2026-10-04T14"
 */
export function bucketKey(iso, tz = 'UTC') {
  const at = new Date(iso ?? '');
  if (Number.isNaN(at.getTime())) return null;
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    }));
  }
  const parts = {};
  for (const p of formatters.get(tz).formatToParts(at)) parts[p.type] = p.value;
  // hourCycle h23 still yields "24" for midnight in some ICU builds.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}`;
}

const emptyBucket = () => ({ n: 0, ok: 0, fail: 0, items: 0, bytes: 0, msSum: 0, msMax: 0, covered: 0 });

/**
 * Hourly counters over a set of rows.
 *
 * `cp` is the per-checkpoint total for the hour, and it is the whole reason
 * checkpoints exist. "How much went from Cratio to Meta?" is a question about a
 * named stage, and "in which hour?" makes it a question about a named stage
 * over time. The funnel cannot answer that — it sums over executions, not over
 * the clock — so the stage totals are bucketed here alongside everything else.
 */
export function bucketsFrom(rows, tz) {
  const out = {};
  for (const row of rows) {
    const key = bucketKey(row.startedAt, tz);
    if (!key) continue;
    const b = (out[key] ??= emptyBucket());
    b.n += 1;
    if (row.status === 'success') b.ok += 1;
    else if (row.status === 'error') b.fail += 1;
    if (Number.isFinite(row.items)) { b.items += row.items; b.covered += 1; }
    if (Number.isFinite(row.bytes)) b.bytes += row.bytes;
    if (Number.isFinite(row.ms)) { b.msSum += row.ms; b.msMax = Math.max(b.msMax, row.ms); }

    for (const [node, items] of Object.entries(row.checkpoints ?? {})) {
      // null means the stage did not run in that execution. Counting it as 0
      // would make "the CRM insert never happened" read as "the CRM insert
      // produced nothing", and only one of those is a code problem.
      if (!Number.isFinite(items)) continue;
      b.cp ??= {};
      b.cp[node] = (b.cp[node] ?? 0) + items;
    }
  }
  return out;
}

/**
 * Fold freshly computed buckets into the stored ones.
 *
 * A bucket whose rows have aged out of retention must keep the numbers it had
 * when they were still there, so the stored value wins whenever it is larger.
 * Every counter is monotonic — rows only ever disappear — which makes `max`
 * the right merge and means a partially-pruned hour is not silently halved.
 */
export function mergeBuckets(stored, fresh) {
  const out = { ...stored };
  for (const [key, b] of Object.entries(fresh)) {
    const old = out[key];
    if (!old) { out[key] = b; continue; }
    const merged = {
      n: Math.max(old.n ?? 0, b.n),
      ok: Math.max(old.ok ?? 0, b.ok),
      fail: Math.max(old.fail ?? 0, b.fail),
      items: Math.max(old.items ?? 0, b.items),
      bytes: Math.max(old.bytes ?? 0, b.bytes),
      msSum: Math.max(old.msSum ?? 0, b.msSum),
      msMax: Math.max(old.msMax ?? 0, b.msMax),
      covered: Math.max(old.covered ?? 0, b.covered),
    };
    // Per stage, for the same reason: the stored figure was computed when more
    // rows existed, so it wins. A stage added to the workflow today appears
    // from today without disturbing the stages already recorded.
    if (old.cp || b.cp) {
      merged.cp = { ...(old.cp ?? {}) };
      for (const [node, items] of Object.entries(b.cp ?? {})) {
        merged.cp[node] = Math.max(merged.cp[node] ?? 0, items);
      }
    }
    out[key] = merged;
  }
  return out;
}

/* ------------------------------------------------------------ retention */

/** Newest first, inside rawDays, no more than maxRows, node detail on the newest few. */
export function pruneRows(rows, { rawDays, maxRows, keepNodeDetail }, now = new Date()) {
  const cutoff = now.getTime() - rawDays * 86400000;
  const kept = rows
    .filter((r) => {
      const at = Date.parse(r.startedAt ?? '');
      return !Number.isFinite(at) || at >= cutoff;
    })
    .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? ''))
      || Number(b.id) - Number(a.id))
    .slice(0, maxRows);

  // Node detail is the bulk of a row. Keep it on the newest few and on every
  // failure — a funnel is a question about the current shape, an error is
  // worth keeping for as long as the row exists.
  return kept.map((row, i) => {
    if (!row.nodes) return row;
    if (i < keepNodeDetail || row.status === 'error') return row;
    const { nodes: _nodes, ...rest } = row;
    return { ...rest, nodesDropped: true };
  });
}

export function pruneBuckets(buckets, { bucketDays }, now = new Date()) {
  const cutoff = new Date(now.getTime() - bucketDays * 86400000).toISOString().slice(0, 10);
  const out = {};
  for (const [key, b] of Object.entries(buckets)) {
    if (key.slice(0, 10) >= cutoff) out[key] = b;
  }
  return out;
}

/* --------------------------------------------------------------- store */

export const storePath = (key) => abs(...RUNS_DIR, `${key}.json`);

export function loadStore(workflow) {
  const file = storePath(workflow.key);
  const result = readJson(file);
  if (!result.ok) {
    return {
      instance: workflow.instance, workflowId: workflow.id, name: workflow.name ?? workflow.id,
      tz: null, rows: [], buckets: {}, sync: {},
    };
  }
  return result.value;
}

/** Every collected workflow on disk, whether or not it is still registered. */
export function loadAllStores() {
  const dir = abs(...RUNS_DIR);
  if (!exists(dir)) return [];
  const out = [];
  for (const file of listFiles(dir, isJson)) {
    const result = readJson(file);
    if (result.ok) out.push({ file: rel(file), ...result.value });
  }
  return out;
}

/* ----------------------------------------------------------- the pass */

/** Run `fn` over `items` with at most `width` in flight. */
async function pool(items, width, fn) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Which rows are worth spending a detail request on.
 *
 * Failures first: the failed node and the error message only exist in the
 * detail payload, and a failure nobody can explain is the least useful kind.
 * Then newest-first, because a funnel describes the current shape.
 *
 * A row already tried and found to have no node data is never retried — n8n
 * prunes execution data on its own schedule, so for an old execution the
 * answer will not change, and retrying it every pass forever is how a
 * collector turns into a load problem.
 */
export function detailCandidates(rows, budget) {
  const want = rows.filter((r) => r.volumeSource !== 'node-data' && !r.detailTried);
  want.sort((a, b) => (a.status === 'error' ? 0 : 1) - (b.status === 'error' ? 0 : 1)
    || String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  return want.slice(0, Math.max(0, budget));
}

async function syncOne(workflow, instance, { retention, tz, now }) {
  const store = loadStore(workflow);
  const previous = store.sync ?? {};
  const started = Date.now();

  const cursorAt = full ? null : previous.cursorStartedAt ?? null;
  const stopAtId = full ? null : previous.lastExecutionId ?? null;

  // Shared by the list pass and the detail pass so the two can never disagree
  // about which checkpoints or dimensions a row carries.
  const rowOpts = {
    checkpoints: workflow.checkpoints,
    dimensions: workflow.dimensions ?? [],
    // Never written to data/, and absent by default: with no salt, an
    // identifier dimension is refused rather than hashed with a constant.
    salt: process.env.KW_DIMENSION_SALT ?? null,
  };

  const { executions, pages, ms, truncated } = await driverFor(instance).fetchExecutions(instance, workflow.id, {
    startedAfter: cursorAt,
    stopAtId,
  });

  const byId = new Map((store.rows ?? []).map((r) => [String(r.id), r]));
  let added = 0;
  for (const execution of executions) {
    const row = toRow(execution, rowOpts);
    if (!row.id) continue;
    const existing = byId.get(row.id);
    // A row that already has node data must not be downgraded by a later list
    // response, which never carries any.
    if (existing?.volumeSource === 'node-data' && row.volumeSource !== 'node-data') {
      byId.set(row.id, { ...existing, status: row.status, stoppedAt: row.stoppedAt, ms: row.ms });
      continue;
    }
    if (!existing) added += 1;
    byId.set(row.id, existing ? { ...existing, ...row } : row);
  }

  /* node-level detail, budgeted */
  const candidates = detailCandidates([...byId.values()], workflow.nodeDetailBudget ?? 150);
  let detailed = 0;
  let detailMs = 0;
  const failures = [];

  /** Fold one fetched payload back into the row it belongs to. */
  const absorb = (row, execution) => {
    if (!execution) {
      // Gone between the list and the fetch. n8n prunes on its own schedule,
      // so this is normal operation; the metadata row stays, because it is
      // still a real execution that really happened.
      byId.set(row.id, { ...row, detailTried: true, dataWithheld: row.dataWithheld ?? 'pruned by n8n' });
      return;
    }
    const enriched = toRow(execution, rowOpts);
    const merged = { ...row, ...enriched };
    if (enriched.volumeSource !== 'node-data') merged.detailTried = true;
    else detailed += 1;
    byId.set(row.id, merged);
  };

  const driver = driverFor(instance);

  if (typeof driver.fetchExecutionDetails === 'function' && candidates.length > 1) {
    /* One query for many.
       Asking a database for detail one execution at a time costs one process
       spawn per execution — about 2,000 of them on a first backfill, eight to
       seventeen seconds per workflow, and output that looks exactly like a
       hang. The API driver pays a round trip each and cannot avoid it; a
       database can answer in bulk, and not using that was throwing away the
       main reason to read one. */
    try {
      const got = await driver.fetchExecutionDetails(instance, candidates.map((r) => r.id));
      detailMs += got.ms ?? 0;
      const byExecutionId = new Map(got.executions.map((e) => [String(e.id), e]));
      for (const row of candidates) absorb(row, byExecutionId.get(String(row.id)) ?? null);
    } catch (e) {
      // A failed bulk read must not cost the workflow its metadata rows.
      failures.push(`bulk detail: ${e.message}`);
      for (const row of candidates) byId.set(row.id, { ...row, detailTried: true });
    }
    return finish();
  }

  await pool(candidates, 4, async (row) => {
    try {
      const got = await driver.fetchExecutionDetail(instance, row.id);
      detailMs += got?.ms ?? 0;
      absorb(row, got?.execution ?? null);
    } catch (e) {
      // One bad execution must not fail the workflow.
      failures.push(`execution ${row.id}: ${e.message}`);
      byId.set(row.id, { ...row, detailTried: true });
    }
  });

  return finish();

  /* Everything after the detail pass is identical whichever route was taken,
     so it lives here rather than being written twice. */
  function finish() {

  /* retention, then buckets */
  const rows = pruneRows([...byId.values()], retention, now);
  const buckets = pruneBuckets(
    // A changed timezone invalidates every stored bucket key, so start again
    // from the rows rather than mixing two griddings in one series.
    mergeBuckets(store.tz && store.tz !== tz ? {} : (store.buckets ?? {}), bucketsFrom(rows, tz)),
    retention,
    now,
  );

  const newest = rows[0] ?? null;
  const next = {
    instance: workflow.instance,
    workflowId: workflow.id,
    name: workflow.name ?? store.name ?? workflow.id,
    project: workflow.project ?? null,
    tz,
    rows,
    buckets,
    sync: {
      status: 'ok',
      lastSyncedAt: new Date(now).toISOString(),
      // The cursor is the newest execution's START, minus a minute of slack.
      // n8n orders by id, and an execution that began before this pass but
      // finished after it would otherwise be skipped forever.
      cursorStartedAt: newest?.startedAt
        ? new Date(Date.parse(newest.startedAt) - 60000).toISOString()
        : previous.cursorStartedAt ?? null,
      lastExecutionId: newest?.id ?? previous.lastExecutionId ?? null,
      lastExecutionAt: newest?.startedAt ?? previous.lastExecutionAt ?? null,
      fetched: executions.length,
      added,
      detailed,
      pages,
      apiMs: ms + detailMs,
      truncated: truncated || undefined,
      error: null,
      warnings: failures.length ? failures.slice(0, 3) : undefined,
    },
  };

  // The same rule ingest follows: nothing credential-shaped is written to
  // data/. An n8n error message quotes the failing request, and that request
  // carries keys. volume.js redacts, this proves it.
  const leaks = scanDeep({ rows, name: next.name });
  if (leaks.length) {
    next.rows = rows.map((r) => ({ ...r, error: r.error ? '[REDACTED:assigned-secret]' : r.error }));
    next.sync.warnings = [...(next.sync.warnings ?? []), `redacted ${leaks.length} credential-shaped string(s) in error text`];
  }

  if (!dryRun) {
    ensureDir(abs(...RUNS_DIR));
    writeJsonIfChanged(storePath(workflow.key), next);
  }

  return {
    ok: true,
    workflow,
    added,
    detailed,
    fetched: executions.length,
    rows: rows.length,
    apiMs: ms + detailMs,
    elapsed: Date.now() - started,
    truncated,
    warnings: failures,
  };
  }
}

/** Record a failure against the workflow without losing a byte of history. */
function recordFailure(workflow, tz, message, now) {
  const store = loadStore(workflow);
  const next = {
    ...store,
    instance: workflow.instance,
    workflowId: workflow.id,
    name: workflow.name ?? store.name ?? workflow.id,
    tz: store.tz ?? tz,
    rows: store.rows ?? [],
    buckets: store.buckets ?? {},
    sync: {
      ...(store.sync ?? {}),
      status: 'failed',
      lastAttemptAt: new Date(now).toISOString(),
      error: String(message).slice(0, 300),
    },
  };
  if (!dryRun) {
    ensureDir(abs(...RUNS_DIR));
    writeJsonIfChanged(storePath(workflow.key), next);
  }
}

export async function runSync({ now = new Date() } = {}) {
  const registry = resolveRegistry();
  const tz = registry.report?.timezone ?? 'Asia/Kolkata';

  for (const e of registry.errors) process.stdout.write(`${yellow('!')} registry: ${e}\n`);

  const monitored = registry.workflows
    .filter((w) => w.monitoring)
    .filter((w) => (only.length ? only.includes(w.id) || only.includes(w.name) : true));

  if (!monitored.length) {
    process.stdout.write(registry.workflows.length
      ? `${yellow('!')} nothing matched. Registered: ${registry.workflows.map((w) => w.id).join(', ')}\n`
      : `${dim('No workflows registered. Add one:  npm run wf-add -- <n8n workflow URL>')}\n`);
    return registry.errors.length ? 1 : 0;
  }

  process.stdout.write(`\n${dim(new Date(now).toISOString().replace('T', ' ').slice(0, 19))} `
    + `collecting ${monitored.length} workflow${monitored.length === 1 ? '' : 's'} `
    + `from ${new Set(monitored.map((w) => w.instance)).size} instance(s), bucketed in ${tz}\n`);

  /* One reachability check per instance, not per workflow. Thirteen workflows
     on a dead instance should report one outage, not thirteen. */
  const instanceState = {};
  for (const id of new Set(monitored.map((w) => w.instance))) {
    const instance = registry.instances[id];
    const probe = await driverFor(instance).ping(instance);
    // What this instance is read through, in the operator's terms. A sqlite
    // instance has no baseUrl, and printing `undefined` next to a tick is the
    // kind of small lie that makes somebody doubt the rest of the output.
    const via = instance.source === 'sqlite'
      ? `sqlite · ${instance.container ?? instance.dbHostPath}${instance.sshHost ? ` via ssh ${instance.sshHost}` : ' (local)'}`
      : instance.baseUrl;

    instanceState[id] = {
      source: instance.source ?? 'api',
      baseUrl: via,
      publicUrl: instance.publicUrl ?? null,
      server: instance.server ?? null,
      ok: probe.ok,
      apiMs: probe.ms,
      error: probe.ok ? null : probe.error,
      checkedAt: new Date(now).toISOString(),
    };
    process.stdout.write(probe.ok
      ? `${green('  ✓')} ${id} ${dim(`${via} · ${probe.ms}ms`)}\n`
      : `${red('  ✗')} ${id} — ${probe.error}\n`);
  }

  const results = [];
  for (const workflow of monitored) {
    const state = instanceState[workflow.instance];
    if (!state.ok) {
      // Not the workflow's fault, and not worth 13 identical error strings.
      recordFailure(workflow, tz, `${workflow.instance} unreachable: ${state.error}`, now);
      results.push({ ok: false, workflow, error: `${workflow.instance} unreachable` });
      continue;
    }
    try {
      const result = await syncOne(workflow, registry.instances[workflow.instance], {
        retention: registry.retention, tz, now,
      });
      results.push(result);
      process.stdout.write(`${green('  ✓')} ${String(workflow.name ?? workflow.id).slice(0, 44).padEnd(46)}`
        + `${dim(`+${result.added} new · ${result.detailed} with node data · ${result.rows} rows · ${result.apiMs}ms`)}\n`);
      if (result.truncated) process.stdout.write(`${yellow('    !')} hit the page cap; run again to continue the backfill\n`);
      for (const w of result.warnings.slice(0, 2)) process.stdout.write(`${dim(`    · ${w}`)}\n`);
    } catch (e) {
      recordFailure(workflow, tz, e.message, now);
      results.push({ ok: false, workflow, error: e.message });
      process.stdout.write(`${red('  ✗')} ${workflow.name ?? workflow.id} — ${e.message}\n`);
    }
  }

  /* The collector's own vitals, so it cannot stop quietly. */
  const okResults = results.filter((r) => r.ok);
  const state = {
    lastRunAt: new Date(now).toISOString(),
    tz,
    instances: instanceState,
    workflows: monitored.length,
    synced: okResults.length,
    failed: results.length - okResults.length,
    added: okResults.reduce((t, r) => t + r.added, 0),
    detailed: okResults.reduce((t, r) => t + r.detailed, 0),
    apiMs: results.reduce((t, r) => t + (r.apiMs ?? 0), 0),
    slowestMs: Math.max(0, ...okResults.map((r) => r.apiMs ?? 0)),
    registryErrors: registry.errors,
    lastError: results.find((r) => !r.ok)?.error ?? null,
    perWorkflow: results.map((r) => ({
      key: r.workflow.key,
      id: r.workflow.id,
      name: r.workflow.name ?? r.workflow.id,
      instance: r.workflow.instance,
      status: r.ok ? 'ok' : 'failed',
      added: r.added ?? 0,
      rows: r.rows ?? 0,
      apiMs: r.apiMs ?? 0,
      error: r.ok ? null : r.error,
    })),
  };
  if (!dryRun) writeJsonIfChanged(abs('data', 'n8n-sync.json'), state);

  /* Workflows that are switched on in n8n but not being watched.

     The registry does not update itself: auto-registering whatever appears
     would mean somebody's afternoon experiment starts mailing seven people.
     But a workflow that has been live for a month and monitored by nobody is
     exactly the gap this module exists to close, so it is reported on every
     pass rather than left to be noticed. */
  if (!only.length) {
    const inventory = readJson(abs('data', 'workflows.json'));
    if (inventory.ok) {
      const watched = new Set(registry.workflows.map((w) => w.id));
      const unwatched = Object.entries(inventory.value)
        .filter(([id, wf]) => wf.active && !wf.noise && !watched.has(id));
      if (unwatched.length) {
        process.stdout.write(`\n${yellow('!')} ${unwatched.length} active workflow`
          + `${unwatched.length === 1 ? ' is' : 's are'} switched on in n8n but not monitored:\n`);
        for (const [id, wf] of unwatched.slice(0, 8)) {
          process.stdout.write(dim(`    ${id.padEnd(22)} ${String(wf.name).slice(0, 50)}\n`));
        }
        if (unwatched.length > 8) process.stdout.write(dim(`    …and ${unwatched.length - 8} more\n`));
        process.stdout.write(dim('    npm run wf-add -- --discover    to take them all on\n'));
      }
    }
  }

  /* A store for a workflow nobody monitors any more is dead weight on every
     build. Report it rather than deleting it — history is expensive to get. */
  if (!only.length) {
    const live = new Set(registry.workflows.map((w) => `${w.key}.json`));
    const dir = abs(...RUNS_DIR);
    if (exists(dir)) {
      for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        if (!live.has(name)) process.stdout.write(`${dim(`· data/runs/${name} is no longer registered; delete it to drop its history`)}\n`);
      }
    }
  }

  process.stdout.write(`\n${state.synced}/${state.workflows} synced · ${state.added} new executions`
    + ` · ${state.detailed} with node data · ${state.apiMs}ms in n8n\n`);
  if (dryRun) process.stdout.write(`${dim('--dry-run: nothing written')}\n`);

  // Exit 0 even with failures: an unreachable n8n is a finding to show, not a
  // broken build, and sync.js must carry on to the rebuild either way.
  return 0;
}

export { statusOf };

// `process.exitCode`, not `process.exit()`. Calling exit() straight out of a
// top-level await, with undici's socket and the request's AbortSignal timer
// still registered, aborts Node 24 on Windows:
//
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
//
// The pass had already finished and reported successfully; the process then
// died with 127. Setting the code and letting the loop drain exits normally
// and propagates the same status to sync.js.
if (path.resolve(process.argv[1] ?? '') === path.resolve(ROOT, 'src', 'n8n', 'collect.js')) {
  process.exitCode = await runSync();
}
