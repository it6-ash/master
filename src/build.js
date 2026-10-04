#!/usr/bin/env node
/**
 * npm run build — data/ + content/ → dist/index.html
 *
 * One self-contained file. All CSS and JS inlined, no network requests, opens
 * from file://.
 *
 * Also writes data/projects.json, the derived merge of every project's
 * frontmatter with its stat references resolved.
 */

import path from 'node:path';

import {
  ROOT, abs, rel, readJson, readText, writeJsonIfChanged, writeTextIfChanged,
  listFiles, listDirs, isJson, isMarkdown,
} from './lib/fsx.js';
import { isoDate } from './lib/units.js';
import { parseFrontmatter } from './parse/frontmatter.js';
import { extractFlowBlocks } from './parse/flow-dsl.js';
import { diffSnapshots, diffWorkflows, stalenessEvents } from './diff.js';
import { deriveProjects, mergeProjects, attachWorkflows } from './derive-projects.js';
import { reconcileIssues } from './claims.js';
import { buildCosts } from './costs.js';
import { checkIssues } from './check.js';
import { resolveRegistry } from './n8n/registry.js';
import { loadStore, bucketKey } from './n8n/collect.js';
import { analyse, series, stageSeries, overview, byProject } from './n8n/analytics.js';
import { nodeFunnel } from './n8n/volume.js';
import { rollup } from './n8n/dimensions.js';
import { renderPage, renderAnalyticsPage } from './render/html.js';

/* ---------------------------------------------------- stat references */

/**
 * $mongo.<db>.<collection>.<field>   docs on a collection
 * $mongo.<collection>.<field>        db inferred when unambiguous
 * $server.<id>.<dotted.path>         any value on a server record
 * $wf.<id>.active                    one workflow's state
 * $wf.group.<Group>.active           count of active workflows in a group
 */
export function resolveStatRef(ref, { servers, workflows }) {
  const parts = ref.slice(1).split('.');
  const ns = parts.shift();

  if (ns === 'server') {
    const [id, ...rest] = parts;
    let cursor = servers[id];
    for (const key of rest) {
      if (cursor == null) return null;
      cursor = cursor[key];
    }
    return cursor ?? null;
  }

  if (ns === 'wf') {
    if (parts[0] === 'group') {
      const group = parts[1];
      const field = parts[2] ?? 'active';
      const list = Object.values(workflows).filter((w) => w.group === group && !w.noise);
      if (field === 'active') return list.filter((w) => w.active).length;
      if (field === 'count') return list.length;
      return null;
    }
    const wf = workflows[parts[0]];
    if (!wf) return null;
    return wf[parts[1] ?? 'active'] ?? null;
  }

  if (ns === 'mongo') {
    const field = parts.pop() ?? 'docs';
    const collectionName = parts.pop();
    const dbName = parts.pop();

    const candidates = [];
    for (const server of Object.values(servers)) {
      for (const [name, db] of Object.entries(server.databases ?? {})) {
        if (dbName && name !== dbName) continue;
        for (const coll of db.collections ?? []) {
          if (coll.name === collectionName) candidates.push(coll);
        }
      }
    }
    if (candidates.length !== 1) return null;
    const value = candidates[0][field === 'count' ? 'docs' : field];
    return value ?? null;
  }

  return null;
}

function resolveStats(stats, context) {
  return (stats ?? []).map((stat) => {
    if (typeof stat.value !== 'string' || !stat.value.startsWith('$')) return { ...stat };
    const resolved = resolveStatRef(stat.value, context);
    if (resolved === null || resolved === undefined) {
      return { ...stat, value: '—', ref: stat.value, unresolved: true };
    }
    return {
      ...stat,
      value: typeof resolved === 'number' ? resolved.toLocaleString('en-US') : String(resolved),
      ref: stat.value,
    };
  });
}

/* ---------------------------------------------------------- snapshots */

/** Per-server series for the card sparklines, oldest first. */
function snapshotHistory() {
  const history = {};
  for (const server of listDirs(abs('data', 'snapshots'))) {
    const series = { disk: [], failed: [], dates: [] };
    for (const file of listFiles(abs('data', 'snapshots', server), isJson).sort()) {
      const snap = readJson(file);
      if (!snap.ok) continue;
      const record = snap.value.record ?? {};
      if (Number.isInteger(record.state?.diskUsedPct)) series.disk.push(record.state.diskUsedPct);
      series.failed.push((record.services ?? []).filter((s) => s.state === 'failed').length);
      series.dates.push(isoDate(snap.value.capturedAt ?? snap.value.takenAt));
    }
    history[server] = series;
  }
  return history;
}

/** Change events across every server, newest first. */
function collectEvents(servers, workflows, today) {
  const events = [];

  // The two most recent collections of each server, which is what the panel
  // says it shows. Diffing every consecutive pair instead meant one bad
  // collection was replayed for as long as its snapshot survived: a broken
  // `nginx -T` on 25 Aug dropped every vhost, and "hostname gone × 13" then sat
  // at the top of the panel for days while genuinely new changes went unnoticed
  // below it. A panel that never clears stops being read.
  for (const server of listDirs(abs('data', 'snapshots'))) {
    const [prevFile, nextFile] = listFiles(abs('data', 'snapshots', server), isJson).sort().slice(-2);
    if (!prevFile || !nextFile) continue;
    const prev = readJson(prevFile);
    const next = readJson(nextFile);
    if (!prev.ok || !next.ok) continue;
    const at = isoDate(next.value.capturedAt ?? next.value.takenAt) ?? today;
    events.push(...diffSnapshots(prev.value.record, next.value.record, { server, at }));
  }

  events.push(...diffWorkflows(workflows).filter((e) => e.type !== 'workflow.appeared'));
  events.push(...stalenessEvents(servers, today));

  const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return events.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')
    || (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}

/* ------------------------------------------------- workflow analytics */

/** How much series the page carries. See seriesPayload() for why these two. */
const HOURLY_DAYS = 7;
const DAILY_DAYS = 90;

/**
 * Execution telemetry, aggregated for the page.
 *
 * All of it happens HERE, at build time, and only the aggregates are inlined.
 * The browser never receives an execution list for the sake of drawing a
 * chart — a workflow with 5,000 held rows contributes 258 numbers.
 *
 * Nothing in this function reaches the network. The collector
 * (`npm run wf-sync`) is the only thing that talks to n8n, so a build works
 * offline, on a laptop, with no API key, and simply has nothing to show.
 */
function buildWorkflowAnalytics({ workflows: inventory, projects, now, warnings }) {
  const registry = resolveRegistry();
  for (const e of registry.errors) warnings.push(`n8n registry: ${e}`);

  const tz = registry.report?.timezone ?? 'Asia/Kolkata';
  const monitored = registry.workflows.filter((w) => w.monitoring);

  const analysed = [];
  const hourly = new Map();
  const daily = new Map();

  for (const workflow of monitored) {
    const store = loadStore(workflow);
    // The name n8n reports beats the one somebody typed into the config, and
    // the inventory already holds it.
    const name = workflow.name ?? inventory[workflow.id]?.name ?? store.name ?? workflow.id;
    const a = analyse({ ...workflow, name }, store, { now, range: '24h', tz, bucketKey });

    // "Nothing collected" has three quite different causes and only one of
    // them is worth acting on. Telling somebody to run wf-sync when they have
    // just run it, about a workflow that is switched off, is noise that
    // teaches them to skim the warnings.
    if (!a.stats.executions && !(store.rows ?? []).length && !Object.keys(store.buckets ?? {}).length) {
      const inventoryEntry = inventory[workflow.id];
      const syncedOk = store.sync?.status === 'ok';
      warnings.push(`n8n: no executions for ${name} (${workflow.id}) — ${
        inventoryEntry && inventoryEntry.active === false
          ? 'it is switched off in n8n, so there is nothing to collect'
          : syncedOk
            ? 'collected fine, n8n simply has no executions for it. Either it has not run, or n8n pruned them'
            : 'nothing has collected it yet — run `npm run wf-sync`'
      }`);
    }
    // A project id that does not exist would put a dead link in the table.
    if (workflow.project && !projects.some((p) => p.id === workflow.project)) {
      warnings.push(`n8n: ${workflow.id} claims project "${workflow.project}", which has no content/projects/ entry`);
    }

    a.funnel = nodeFunnel(store.rows ?? []);
    // What was IN the items, summed over the window the page is showing.
    a.dimensions = rollup((a.stats.rows ?? []).map((r) => r.dimensions).filter(Boolean));
    // Per-stage volume against the clock. 48 hours at hourly, which is the
    // window in which "it stopped reaching Meta at 02:00" is still actionable.
    a.stages = stageSeries(store.buckets ?? {}, {
      from: new Date(new Date(now).getTime() - 48 * 3600000),
      to: new Date(now),
      grain: 'hour',
      tz,
      bucketKey,
      stages: workflow.checkpoints?.length ? workflow.checkpoints : null,
    });
    analysed.push(a);

    const to = new Date(now);
    hourly.set(workflow.key, series(store.buckets ?? {}, {
      from: new Date(to.getTime() - HOURLY_DAYS * 86400000), to, grain: 'hour', tz, bucketKey,
    }));
    daily.set(workflow.key, series(store.buckets ?? {}, {
      from: new Date(to.getTime() - DAILY_DAYS * 86400000), to, grain: 'day', tz, bucketKey,
    }));
  }

  const syncFile = readJson(abs('data', 'n8n-sync.json'));
  return {
    analysed,
    hourly,
    daily,
    tz,
    totals: overview(analysed),
    projects: byProject(analysed),
    instances: registry.instances,
    sync: syncFile.ok ? syncFile.value : null,
    registered: registry.workflows.length,
  };
}

/* --------------------------------------------------------------- main */

function main() {
  const servers = readJson(abs('data', 'servers.json'));
  const workflowsFile = readJson(abs('data', 'workflows.json'));
  const issuesFile = readJson(abs('data', 'issues.json'));

  if (!servers.ok) { process.stderr.write(`data/servers.json: ${servers.error}\n`); process.exit(1); }

  const serverData = servers.value;
  const workflows = workflowsFile.ok ? workflowsFile.value : {};
  const issues = issuesFile.ok ? issuesFile.value : [];

  /* projects: discovered from the servers, then enriched by any doc that exists */
  const documented = [];
  const warnings = [];

  for (const file of listFiles(abs('content', 'projects'), isMarkdown)) {
    const { data, body, bodyStartLine, hasFrontmatter, errors } = parseFrontmatter(readText(file));
    if (!hasFrontmatter) {
      warnings.push(`${rel(file)}: ${errors[0]?.message ?? 'no frontmatter'} — skipped`);
      continue;
    }
    for (const e of errors) warnings.push(`${rel(file)}:${e.line} ${e.message}`);

    const id = data.id ?? path.basename(file, '.md');
    documented.push({
      ...data,
      id,
      name: data.name ?? id,
      status: data.status ?? 'idle',
      stats: resolveStats(data.stats, { servers: serverData, workflows }),
      body,
      bodyStartLine,
      sourceFile: rel(file),
      flows: extractFlowBlocks(body).filter((b) => b.lang === 'flow').length,
    });
  }

  const projects = mergeProjects(documented, deriveProjects(serverData));
  attachWorkflows(projects, workflows, serverData);

  projects.sort((a, b) => {
    // documented first, then live before broken, then by name
    const rank = (p) => (p.origin === 'documented' ? 0 : 1);
    const health = { live: 0, partial: 1, broken: 2, idle: 3 };
    return (a.order ?? (rank(a) === 0 ? 10 : 50)) - (b.order ?? (rank(b) === 0 ? 10 : 50))
      || rank(a) - rank(b)
      || (health[a.status] ?? 9) - (health[b.status] ?? 9)
      || a.name.localeCompare(b.name);
  });

  for (const p of projects) {
    for (const s of p.stats ?? []) {
      if (s.unresolved) warnings.push(`${p.sourceFile}: stat reference ${s.ref} did not resolve`);
    }
  }

  /* derived data/projects.json — everything except the prose */
  const derived = {};
  for (const p of projects) {
    const { body: _body, bodyStartLine: _line, ...rest } = p;
    derived[p.id] = rest;
  }
  writeJsonIfChanged(abs('data', 'projects.json'), derived);

  /* events, history, staleness */
  const today = isoDate(new Date());
  const events = collectEvents(serverData, workflows, today);
  const history = snapshotHistory();

  const staleness = {};
  for (const [id, s] of Object.entries(serverData)) {
    staleness[id] = s.lastIngest
      ? Math.floor((new Date(today) - new Date(s.lastIngest)) / 86400000)
      : null;
  }

  /* re-test every hand-written claim against the newest ingest */
  const reconciled = reconcileIssues(issues, serverData);
  for (const issue of reconciled) {
    if (issue.claimStatus === 'reconciled') {
      warnings.push(`issue "${issue.id}" no longer reproduces: ${issue.claimDetail}`);
    }
  }

  /* the analytical model, with its $references resolved like project stats */
  const analysisFile = readJson(abs('data', 'analysis.json'));
  const analysis = analysisFile.ok ? analysisFile.value : {};
  if (analysis.funnel) {
    analysis.funnel.stages = analysis.funnel.stages.map((stage) => {
      if (typeof stage.value !== 'string' || !stage.value.startsWith('$')) return stage;
      const value = resolveStatRef(stage.value, { servers: serverData, workflows });
      if (value === null || value === undefined) {
        warnings.push(`analysis.json: funnel reference ${stage.value} did not resolve`);
        return { ...stage, value: 0, note: `${stage.note ?? ''} (unresolved)`.trim() };
      }
      return { ...stage, value: Number(value) };
    });
  }

  const glossaryFile = readJson(abs('data', 'glossary.json'));
  const glossary = glossaryFile.ok ? glossaryFile.value : {};

  /* the outside-in check: what the public internet sees, and whether the lead
     forms accept a submission. Nothing on a server reports either. */
  const checksFile = readJson(abs('data', 'checks.json'));
  const checks = checksFile.ok ? checksFile.value : null;
  if (checks) {
    for (const issue of checkIssues(checks)) {
      if (!reconciled.some((i) => i.id === issue.id)) reconciled.push(issue);
      warnings.push(`check: ${issue.title}`);
    }
  }

  /* execution telemetry — what the workflows actually DID, as opposed to
     data/workflows.json, which only says they exist and are switched on */
  const analytics = buildWorkflowAnalytics({
    workflows, projects, now: new Date(), warnings,
  });

  /* what it costs to keep the lights on, and when each line renews */
  const costs = buildCosts(serverData, { today });

  // A cancelled subscription is an outage with a date on it. It belongs in
  // Issues beside the failing units, not only in a table of renewal dates.
  for (const issue of costs.issues) {
    if (!reconciled.some((i) => i.id === issue.id)) reconciled.push(issue);
    warnings.push(`costs: ${issue.title}`);
  }

  if (costs.monthlyTotal !== null && analysis.costScenarios) {
    // The same fixed floor under every scenario. That is the point being made:
    // hosting does not move with volume, WhatsApp does.
    analysis.costScenarios.rows = analysis.costScenarios.rows.map((r) => ({ ...r, infra: costs.monthlyTotal }));
  }
  if (costs.recorded < costs.total) {
    warnings.push(`costs: ${costs.total - costs.recorded} of ${costs.total} lines have no price recorded in data/costs.json`);
  }

  /* render */
  const html = renderPage({
    servers: serverData,
    projects,
    workflows,
    issues: reconciled,
    events,
    history,
    staleness,
    analysis,
    costs,
    checks,
    analytics,
    glossary,
    css: readText(abs('src', 'render', 'styles.css')),
    builtAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  });

  const out = abs('dist', 'index.html');
  writeTextIfChanged(out, `<!doctype html>\n${html}\n`);

  /* Workflow analytics is its own page: a different dataset answering a
     different question, and two thirds of the old single page's bytes were
     telemetry nobody had scrolled to. Still a built artifact rather than a
     server-rendered view, so it is served from the same static path, opens
     from file://, and does not go blank when the admin server restarts. */
  const analyticsHtml = renderAnalyticsPage({
    servers: serverData,
    projects,
    workflows,
    issues: reconciled,
    analytics,
    glossary,
    css: readText(abs('src', 'render', 'styles.css')),
    builtAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  });
  const analyticsOut = abs('dist', 'workflows.html');
  writeTextIfChanged(analyticsOut, `<!doctype html>\n${analyticsHtml}\n`);

  const bytes = Buffer.byteLength(html, 'utf8');
  process.stdout.write(
    `built ${rel(out)}  ${(bytes / 1024).toFixed(0)} KB`
    + `  ·  ${rel(analyticsOut)}  ${(Buffer.byteLength(analyticsHtml, 'utf8') / 1024).toFixed(0)} KB\n`
    + `  ${Object.keys(serverData).length} servers · ${projects.length} projects · `
    + `${Object.keys(workflows).length} workflows · ${reconciled.filter((i) => !i.resolved).length} open issues · ${events.length} change events\n`
    + `  ${analytics.analysed.length} monitored · ${analytics.totals.executions.toLocaleString('en-US')} executions `
    + `· ${analytics.totals.items.toLocaleString('en-US')} items in the last 24h\n`,
  );
  for (const w of warnings) process.stdout.write(`  warn  ${w}\n`);
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(ROOT, 'src', 'build.js')) main();
