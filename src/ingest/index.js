#!/usr/bin/env node
/**
 * npm run ingest              scan raw/, detect format, update data/, snapshot
 * npm run ingest -- raw/x.txt ingest one specific file
 *
 * Idempotent (§4): a file whose sha256 already has a snapshot for that server
 * is skipped entirely, so running twice changes nothing the second time.
 * Pass --force to re-ingest anyway.
 *
 * Order of operations per file, per §9:
 *   1. parse
 *   2. write data/snapshots/<server>/<ISO>.json   BEFORE merging
 *   3. merge into data/servers.json / workflows.json
 * then, once across all files, regenerate the source:"auto" issues.
 */

import path from 'node:path';
import fs from 'node:fs';

import {
  ROOT, abs, rel, exists, readJson, readText, writeJsonIfChanged,
  listFiles, listDirs, isJson, sha256, serializeJson,
} from '../lib/fsx.js';
import { isoDate, snapshotStamp } from '../lib/units.js';
import { scanDeep } from '../lib/redact.js';
import { autoIssues } from '../diff.js';
import { parseVpsDump } from './vps-dump.js';
import { parseN8nList, groupFor, isNoise } from './n8n-list.js';
import { parseMongoStats } from './mongo-stats.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const targets = args.filter((a) => !a.startsWith('--'));

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (color ? `[${c}m${s}[0m` : s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const red = (s) => paint('31', s);
const dim = (s) => paint('2', s);

/* ---------------------------------------------------- format detection */

/**
 * §8d. Sniff the content, never the filename.
 * @returns {{ format: string, confidence: string, why: string }}
 */
export function detectFormat(text) {
  const head = text.slice(0, 8000);

  if (/^===SECTION:[A-Z0-9_]+===/m.test(head) || /^===MANIFEST===/m.test(head)) {
    return { format: 'vps-dump', confidence: 'high', why: 'kw-collect.sh section headers' };
  }
  if (/hostnamectl|Static hostname:/i.test(head)) {
    return { format: 'vps-dump', confidence: 'medium', why: 'hostnamectl output present' };
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const pipePairs = lines.filter((l) => /^[A-Za-z0-9_-]{8,36}\|.+/.test(l)).length;
  const docCounts = lines.filter((l) => /^\S+\s*[|:]?\s+\d[\d,]*\s*(docs?|documents?)\s*$/i.test(l)).length;
  const tabTriples = lines.filter((l) => /^[A-Za-z_][\w.-]*\t[A-Za-z_][\w.-]*\t\d+$/.test(l)).length;

  if (docCounts >= 1 && docCounts >= pipePairs) {
    return { format: 'mongo-stats', confidence: 'high', why: `${docCounts} "<collection> <n> docs" lines` };
  }
  if (tabTriples >= 1 && tabTriples >= pipePairs) {
    return { format: 'mongo-stats', confidence: 'high', why: `${tabTriples} tab-separated db/collection/count lines` };
  }
  if (pipePairs >= 1 && pipePairs >= lines.length * 0.5) {
    return { format: 'n8n-list', confidence: 'high', why: `${pipePairs} <id>|<name> lines` };
  }
  if (pipePairs >= 1) {
    return { format: 'n8n-list', confidence: 'low', why: `${pipePairs} <id>|<name> lines among ${lines.length}` };
  }

  return { format: 'unknown', confidence: 'none', why: 'no recognisable markers' };
}

/* ------------------------------------------------------------- merging */

/**
 * Section-wise merge: a key the parser did not emit keeps its previous value.
 * That is what makes a truncated dump safe (§8a).
 */
function mergeServer(previous, incoming) {
  const merged = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  // `state` is volatile and always replaced wholesale when present, but a
  // dump missing PACKAGES must not drop kernelInstalled from an earlier one.
  if (previous?.state && incoming.state) {
    merged.state = { ...previous.state, ...incoming.state };
  }
  if (previous?.specs && incoming.specs) {
    merged.specs = { ...previous.specs, ...incoming.specs };
  }
  if (previous?.databases && incoming.databases) {
    merged.databases = { ...previous.databases, ...incoming.databases };
  }
  return merged;
}

/**
 * Workflow state, with history recording CHANGES only so the dashboard can
 * say "deactivated 3 days ago".
 */
function mergeWorkflows(store, incoming, { server, date }) {
  const seen = new Set(Object.keys(incoming));

  for (const [id, wf] of Object.entries(incoming)) {
    const prior = store[id];
    const entry = {
      name: wf.name,
      active: wf.active,
      group: groupFor(wf.name),
      noise: isNoise(wf.name),
      firstSeen: prior?.firstSeen ?? date,
      lastSeen: date,
      history: prior?.history ? [...prior.history] : [],
    };
    if (server) entry.server = server;

    const lastState = entry.history.length ? entry.history[entry.history.length - 1].active : null;
    if (lastState === null || lastState !== wf.active) {
      entry.history.push({ date, active: wf.active });
    }
    if (prior?.missingSince) entry.missingSince = null;

    store[id] = entry;
  }

  // Ids we used to see on THIS server but no longer do.
  for (const [id, wf] of Object.entries(store)) {
    if (seen.has(id)) continue;
    if (server && wf.server && wf.server !== server) continue;
    if (!wf.missingSince) store[id] = { ...wf, missingSince: date };
  }

  return store;
}

/* ------------------------------------------------------------- ingesting */

function snapshotExistsForSha(server, hash) {
  for (const file of listFiles(abs('data', 'snapshots', server), isJson)) {
    const snap = readJson(file);
    if (snap.ok && snap.value.sourceSha256 === hash) return path.basename(file);
  }
  return null;
}

function writeSnapshot(server, snapshot) {
  const stamp = snapshotStamp(snapshot.capturedAt ?? snapshot.takenAt) ?? snapshotStamp(new Date());
  const file = abs('data', 'snapshots', server, `${stamp}.json`);
  if (dryRun) return { file, written: false };
  return { file, written: writeJsonIfChanged(file, snapshot) };
}

/**
 * Keep the newest KEEP_SNAPSHOTS per server and delete the rest.
 *
 * Hand-fed, this never fires. On the 6-hourly timer it is the difference
 * between a dashboard and a disk problem: each snapshot is ~45 KB, the build
 * reads and diffs EVERY consecutive pair on every run, and validate parses all
 * of them. 60 is a fortnight of 6-hourly collection, which is more history than
 * the "what changed" panel shows.
 */
export const KEEP_SNAPSHOTS = 60;

export function pruneSnapshots(server, keep = KEEP_SNAPSHOTS) {
  const files = listFiles(abs('data', 'snapshots', server), isJson).sort(); // names sort chronologically
  const doomed = files.slice(0, Math.max(0, files.length - keep));
  for (const file of doomed) fs.rmSync(file, { force: true });
  return doomed.length;
}

function main() {
  const files = targets.length
    ? targets.map((t) => path.resolve(ROOT, t))
    : listFiles(abs('raw'), (n) => !n.startsWith('.'));

  if (files.length === 0) {
    process.stdout.write('Nothing in raw/ to ingest.\n');
    process.exit(0);
  }

  const serversStore = readJson(abs('data', 'servers.json'));
  const workflowsStore = readJson(abs('data', 'workflows.json'));
  const issuesStore = readJson(abs('data', 'issues.json'));

  const servers = serversStore.ok ? serversStore.value : {};
  const workflows = workflowsStore.ok ? workflowsStore.value : {};
  const issues = issuesStore.ok ? issuesStore.value : [];

  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  const touchedServers = new Set();

  for (const file of files) {
    if (!exists(file)) { process.stdout.write(`${red('✗')} ${rel(file)} — not found\n`); failed += 1; continue; }

    const text = readText(file);
    const hash = sha256(text);
    const source = rel(file);
    const { format, confidence, why } = detectFormat(text);

    if (format === 'unknown') {
      process.stdout.write(`${red('✗')} ${source} — could not detect format (${why}). Not writing anything.\n`);
      failed += 1;
      continue;
    }
    if (confidence === 'low') {
      // §8d: say what we think and stop, rather than guessing into data/.
      process.stdout.write(`${yellow('?')} ${source} — looks like ${format} (${why}), but I am not confident.\n`);
      process.stdout.write(`    Re-run with the file named explicitly to accept: npm run ingest -- ${source}\n`);
      if (!targets.length) { skipped += 1; continue; }
    }

    if (format === 'vps-dump') {
      const result = parseVpsDump(text, { sourceFile: source });
      if (!result.server) {
        process.stdout.write(`${red('✗')} ${source} — ${result.warnings[0] ?? 'no server identified'}\n`);
        failed += 1;
        continue;
      }

      const already = force ? null : snapshotExistsForSha(result.server, hash);
      if (already) {
        process.stdout.write(`${dim(`· ${source} — already ingested as ${already}`)}\n`);
        skipped += 1;
        continue;
      }

      const leaks = scanDeep(result.record);
      if (leaks.length) {
        process.stdout.write(`${red('✗')} ${source} — refusing to write: ${leaks[0].kind} at ${leaks[0].path}\n`);
        failed += 1;
        continue;
      }

      const snapshot = {
        server: result.server,
        takenAt: new Date().toISOString(),
        capturedAt: result.capturedAt,
        sourceFile: source,
        sourceSha256: hash,
        parser: 'vps-dump',
        parserVersion: '2.0.0',
        warnings: result.warnings,
        record: result.record,
      };
      const { file: snapFile } = writeSnapshot(result.server, snapshot);

      const date = isoDate(result.capturedAt) ?? isoDate(new Date());
      const previous = servers[result.server];
      servers[result.server] = mergeServer(previous, {
        ...result.record,
        firstSeen: previous?.firstSeen ?? date,
      });
      mergeWorkflows(workflows, result.workflows, { server: result.server, date });

      touchedServers.add(result.server);
      ingested += 1;

      const wfCount = Object.keys(result.workflows).length;
      process.stdout.write(
        `${green('✓')} ${source}\n`
        + `    ${result.server}  ${dim(`snapshot ${rel(snapFile)}`)}\n`
        + `    ${result.record.services?.length ?? 0} services · ${result.record.ports?.length ?? 0} ports · `
        + `${result.record.containers?.length ?? 0} containers · ${result.record.vhosts?.length ?? 0} vhosts · ${wfCount} workflows\n`,
      );
      for (const w of result.warnings) process.stdout.write(`    ${yellow('warn')} ${w}\n`);
      continue;
    }

    if (format === 'n8n-list') {
      const { workflows: parsed, warnings } = parseN8nList(text);
      const date = isoDate(new Date());
      mergeWorkflows(workflows, parsed, { server: null, date });
      ingested += 1;
      process.stdout.write(`${green('✓')} ${source}\n    ${Object.keys(parsed).length} workflows\n`);
      for (const w of warnings) process.stdout.write(`    ${yellow('warn')} ${w}\n`);
      continue;
    }

    if (format === 'mongo-stats') {
      const { databases, warnings } = parseMongoStats(text);
      // Attach to the only server that runs mongo, unless there is exactly one.
      const mongoServers = Object.entries(servers)
        .filter(([, s]) => s.databaseEngines?.mongod === 'active' || s.databases);
      if (mongoServers.length !== 1) {
        process.stdout.write(`${yellow('?')} ${source} — ${mongoServers.length} candidate servers run Mongo; cannot attribute. Ingest a VPS dump first.\n`);
        skipped += 1;
        continue;
      }
      const [serverId, server] = mongoServers[0];
      server.databases = { ...(server.databases ?? {}), ...databases };
      touchedServers.add(serverId);
      ingested += 1;
      process.stdout.write(`${green('✓')} ${source}\n    ${serverId}: ${Object.keys(databases).join(', ')}\n`);
      for (const w of warnings) process.stdout.write(`    ${yellow('warn')} ${w}\n`);
    }
  }

  /* ------------------------------------------------------- prune snapshots */

  if (!dryRun) {
    let dropped = 0;
    for (const server of touchedServers) dropped += pruneSnapshots(server);
    if (dropped) process.stdout.write(`${dim(`· pruned ${dropped} snapshot${dropped === 1 ? '' : 's'} beyond the newest ${KEEP_SNAPSHOTS}`)}\n`);
  }

  /* ------------------------------------------------- regenerate auto issues */

  const today = isoDate(new Date());
  const manual = issues.filter((i) => i.source !== 'auto');
  const generated = autoIssues(servers, { today, previous: issues });
  const nextIssues = [...manual, ...generated];

  if (dryRun) {
    process.stdout.write(`\n${dim('--dry-run: nothing written')}\n`);
  } else {
    writeJsonIfChanged(abs('data', 'servers.json'), servers);
    writeJsonIfChanged(abs('data', 'workflows.json'), workflows);
    writeJsonIfChanged(abs('data', 'issues.json'), nextIssues);
  }

  const bySeverity = generated.reduce((acc, i) => { acc[i.severity] = (acc[i.severity] ?? 0) + 1; return acc; }, {});
  const severitySummary = ['critical', 'high', 'medium', 'low']
    .filter((s) => bySeverity[s])
    .map((s) => `${bySeverity[s]} ${s}`)
    .join(' · ') || 'none';

  process.stdout.write(
    `\n${ingested} ingested · ${skipped} skipped · ${failed} failed\n`
    + `${Object.keys(servers).length} servers · ${Object.keys(workflows).length} workflows · `
    + `${manual.length} manual issues · ${generated.length} auto issues (${severitySummary})\n`,
  );

  if (failed > 0) process.exit(1);
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(ROOT, 'src', 'ingest', 'index.js')) main();
