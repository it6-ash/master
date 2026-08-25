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
import { renderPage } from './render/html.js';

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

  for (const server of listDirs(abs('data', 'snapshots'))) {
    const files = listFiles(abs('data', 'snapshots', server), isJson).sort();
    for (let i = 1; i < files.length; i += 1) {
      const prev = readJson(files[i - 1]);
      const next = readJson(files[i]);
      if (!prev.ok || !next.ok) continue;
      const at = isoDate(next.value.capturedAt ?? next.value.takenAt) ?? today;
      events.push(...diffSnapshots(prev.value.record, next.value.record, { server, at }));
    }
  }

  events.push(...diffWorkflows(workflows).filter((e) => e.type !== 'workflow.appeared'));
  events.push(...stalenessEvents(servers, today));

  const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return events.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')
    || (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
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
    glossary,
    css: readText(abs('src', 'render', 'styles.css')),
    builtAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  });

  const out = abs('dist', 'index.html');
  writeTextIfChanged(out, `<!doctype html>\n${html}\n`);

  const bytes = Buffer.byteLength(html, 'utf8');
  process.stdout.write(
    `built ${rel(out)}  ${(bytes / 1024).toFixed(0)} KB\n`
    + `  ${Object.keys(serverData).length} servers · ${projects.length} projects · `
    + `${Object.keys(workflows).length} workflows · ${issues.filter((i) => !i.resolved).length} open issues · ${events.length} change events\n`,
  );
  for (const w of warnings) process.stdout.write(`  warn  ${w}\n`);
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(ROOT, 'src', 'build.js')) main();
