#!/usr/bin/env node
/**
 * npm run validate — schema-check everything, exit non-zero on error.
 *
 * Hard failures (brief §11):
 *   - unknown `server` reference in a project
 *   - duplicate project `id`
 *   - edge referencing a missing node
 *   - malformed frontmatter
 *   - ANY credential-shaped string anywhere in data/
 * plus: every data file must satisfy its schema.
 *
 * Warnings never fail the build. They are the things that are usually fine
 * mid-stage: an unresolved stat reference, a workflow id not yet ingested.
 *
 * Flags: --json  machine-readable report
 *        --quiet only print the summary line
 */

import path from 'node:path';

import { SchemaRegistry } from './lib/json-schema.js';
import { scanDeep } from './lib/redact.js';
import {
  ROOT, abs, rel, exists, readJson, readText,
  listFiles, listDirs, isJson, isMarkdown,
} from './lib/fsx.js';
import { parseFrontmatter } from './parse/frontmatter.js';
import { parseFlow, extractFlowBlocks } from './parse/flow-dsl.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const quiet = args.includes('--quiet');

const findings = [];
const add = (level, file, message, loc = null) => findings.push({ level, file, message, loc });
const fail = (file, message, loc) => add('error', file, message, loc);
const warn = (file, message, loc) => add('warn', file, message, loc);

/* ---------------------------------------------------------- schema load */

const registry = new SchemaRegistry();
const schemaDir = abs('schema');

for (const file of listFiles(schemaDir, isJson)) {
  const result = readJson(file);
  if (!result.ok) {
    fail(rel(file), result.error);
    continue;
  }
  const id = result.value.$id ?? path.basename(file);
  registry.add(result.value, id);
}

/** Validate a parsed value against a registered schema, reporting each error. */
function checkSchema(file, schemaId, value) {
  if (!registry.get(schemaId)) {
    fail(rel(file), `schema ${schemaId} is missing from schema/`);
    return false;
  }
  const errors = registry.validate(schemaId, value);
  for (const e of errors) fail(rel(file), `${e.path} — ${e.message}`);
  return errors.length === 0;
}

/* ------------------------------------------------------------ data files */

function loadDataFile(name, schemaId, { required = true, fallback = null } = {}) {
  const file = abs('data', name);
  if (!exists(file)) {
    if (required) fail(`data/${name}`, 'missing — expected this file to exist');
    return fallback;
  }
  const result = readJson(file);
  if (!result.ok) {
    fail(`data/${name}`, result.error);
    return fallback;
  }
  checkSchema(file, schemaId, result.value);

  // §11: no credential-shaped string may survive anywhere in data/.
  for (const hit of scanDeep(result.value)) {
    fail(`data/${name}`, `credential-shaped string (${hit.kind}) at ${hit.path} — ingest must redact this: ${hit.preview}`);
  }

  return result.value;
}

const servers = loadDataFile('servers.json', 'servers.schema.json', { fallback: {} }) ?? {};
const workflows = loadDataFile('workflows.json', 'workflows.schema.json', { fallback: {} }) ?? {};
const issues = loadDataFile('issues.json', 'issues.schema.json', { fallback: [] }) ?? [];
const projectsJson = loadDataFile('projects.json', 'projects.schema.json', { required: false, fallback: null });

const serverIds = new Set(Object.keys(servers));
const workflowIds = new Set(Object.keys(workflows));

/* ------------------------------------------------------------- snapshots */

const snapshotRoot = abs('data', 'snapshots');
let snapshotCount = 0;

for (const dir of listDirs(snapshotRoot)) {
  if (!serverIds.has(dir)) {
    warn(`data/snapshots/${dir}`, `snapshot directory has no matching server in data/servers.json`);
  }
  for (const file of listFiles(path.join(snapshotRoot, dir), isJson)) {
    snapshotCount += 1;
    const result = readJson(file);
    if (!result.ok) {
      fail(rel(file), result.error);
      continue;
    }
    checkSchema(file, 'snapshot.schema.json', result.value);

    for (const hit of scanDeep(result.value)) {
      fail(rel(file), `credential-shaped string (${hit.kind}) at ${hit.path}: ${hit.preview}`);
    }

    if (result.value?.server && result.value.server !== dir) {
      fail(rel(file), `snapshot says server "${result.value.server}" but lives in data/snapshots/${dir}/`);
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{4,6}\.json$/.test(path.basename(file))) {
      warn(rel(file), 'filename should be <ISO-date>T<HHMM>.json so snapshots sort chronologically');
    }
  }
}

/* -------------------------------------------------------------- projects */

const projectDir = abs('content', 'projects');
const seenProjectIds = new Map();
const projectFiles = listFiles(projectDir, isMarkdown);

if (projectFiles.length === 0) {
  warn('content/projects/', 'no project docs found — the dashboard grid will be empty');
}

for (const file of projectFiles) {
  const label = rel(file);
  const slug = path.basename(file, '.md');
  let text;
  try {
    text = readText(file);
  } catch (e) {
    fail(label, `unreadable: ${e.message}`);
    continue;
  }

  const { data, body, bodyStartLine, hasFrontmatter, errors } = parseFrontmatter(text);
  for (const e of errors) fail(label, e.message, e.line);
  if (!hasFrontmatter) continue;

  checkSchemaAt(label, 'project-frontmatter.schema.json', data);

  // id must equal the filename slug, and be unique across the folder
  if (data.id && data.id !== slug) {
    fail(label, `frontmatter id "${data.id}" does not match the filename slug "${slug}"`);
  }
  const idKey = data.id ?? slug;
  if (seenProjectIds.has(idKey)) {
    fail(label, `duplicate project id "${idKey}" — already declared in ${seenProjectIds.get(idKey)}`);
  } else {
    seenProjectIds.set(idKey, label);
  }

  // server must exist
  if (data.server != null) {
    if (!serverIds.has(data.server)) {
      fail(label, `unknown server "${data.server}" — not a key in data/servers.json`);
    } else {
      const known = new Set([
        ...(servers[data.server].services ?? []).map((s) => s.name),
        ...(servers[data.server].containers ?? []).map((c) => c.name),
      ]);
      for (const svc of data.services ?? []) {
        if (known.size > 0 && !known.has(svc)) {
          warn(label, `service "${svc}" is not among the services or containers ingested for ${data.server}`);
        }
      }
    }
  }

  // workflow ids: a warning, not an error — workflows.json is machine-populated
  for (const id of data.workflows ?? []) {
    if (!workflowIds.has(id)) {
      warn(label, `workflow id "${id}" is not in data/workflows.json yet`);
    }
  }

  // stat references
  for (const stat of data.stats ?? []) {
    if (typeof stat.value !== 'string' || !stat.value.startsWith('$')) continue;
    if (!/^\$[a-z]+(?:\.[A-Za-z0-9_-]+)+$/.test(stat.value)) {
      fail(label, `malformed stat reference "${stat.value}"`);
      continue;
    }
    const ns = stat.value.slice(1).split('.')[0];
    if (!['mongo', 'server', 'wf'].includes(ns)) {
      fail(label, `unknown stat reference namespace "$${ns}" — expected $mongo, $server or $wf`);
    }
  }

  // flow blocks
  const blocks = extractFlowBlocks(body, { startLine: bodyStartLine });
  for (const block of blocks) {
    if (block.unterminated) {
      fail(label, `unterminated \`\`\`${block.lang} fence`, block.fenceLine);
    }
    if (block.lang !== 'flow') continue;
    const flow = parseFlow(block.code, { startLine: block.startLine });
    for (const e of flow.errors) fail(label, e.message, e.line);
    for (const w of flow.warnings) warn(label, w.message, w.line);
    if (flow.nodes.length === 0 && flow.errors.length === 0) {
      warn(label, 'flow block declares no nodes', block.startLine);
    }
  }
}

function checkSchemaAt(label, schemaId, value) {
  const errors = registry.validate(schemaId, value);
  for (const e of errors) fail(label, `frontmatter ${e.path} — ${e.message}`);
}

/* ------------------------------------------- cross-references in data/ */

for (const [id, wf] of Object.entries(workflows)) {
  if (wf.server != null && !serverIds.has(wf.server)) {
    fail('data/workflows.json', `workflow ${id} references unknown server "${wf.server}"`);
  }
  const changes = wf.history ?? [];
  for (let i = 1; i < changes.length; i += 1) {
    if (changes[i].date < changes[i - 1].date) {
      warn('data/workflows.json', `workflow ${id} history is not in chronological order`);
      break;
    }
  }
}

const issueIds = new Set();
for (const issue of issues) {
  const where = `issue "${issue?.id ?? '?'}"`;
  if (issue?.id) {
    if (issueIds.has(issue.id)) fail('data/issues.json', `duplicate issue id "${issue.id}"`);
    issueIds.add(issue.id);
  }
  if (issue?.server != null && !serverIds.has(issue.server)) {
    fail('data/issues.json', `${where} references unknown server "${issue.server}"`);
  }
  if (issue?.project != null && !seenProjectIds.has(issue.project)) {
    fail('data/issues.json', `${where} references unknown project "${issue.project}" — no content/projects/${issue.project}.md`);
  }
  if (issue?.source === 'auto' && !issue.rule) {
    fail('data/issues.json', `${where} has source=auto but no rule — auto issues must name the §9 rule that fired`);
  }
  if (issue?.source === 'manual' && issue.rule) {
    warn('data/issues.json', `${where} is manual but carries rule="${issue.rule}"`);
  }
  if (issue?.resolved && issue.opened && issue.resolved < issue.opened) {
    fail('data/issues.json', `${where} was resolved (${issue.resolved}) before it was opened (${issue.opened})`);
  }
}

if (projectsJson) {
  for (const [id, project] of Object.entries(projectsJson)) {
    // A derived project having no Markdown file is the normal case — most
    // things deployed on these servers will never be written up. Only a
    // project that CLAIMS to be documented and has lost its file is stale.
    if (project.origin === 'documented' && !seenProjectIds.has(id)) {
      warn('data/projects.json', `project "${id}" is marked documented but content/projects/${id}.md is gone — rerun build`);
    }
  }
}

/* ---------------------------------------------------------------- report */

const errors = findings.filter((f) => f.level === 'error');
const warnings = findings.filter((f) => f.level === 'warn');

if (asJson) {
  process.stdout.write(`${JSON.stringify({
    ok: errors.length === 0,
    counts: {
      errors: errors.length,
      warnings: warnings.length,
      servers: serverIds.size,
      workflows: workflowIds.size,
      projects: seenProjectIds.size,
      issues: issues.length,
      snapshots: snapshotCount,
    },
    findings,
  }, null, 2)}\n`);
  process.exit(errors.length === 0 ? 0 : 1);
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `[${code}m${s}[0m` : s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const green = (s) => paint('32', s);
const dim = (s) => paint('2', s);

if (!quiet) {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  for (const [file, list] of [...byFile.entries()].sort()) {
    const worst = list.some((f) => f.level === 'error') ? red('✗') : yellow('!');
    process.stdout.write(`\n${worst} ${file}\n`);
    for (const f of list) {
      const at = f.loc ? dim(`:${f.loc}`) : '';
      const tag = f.level === 'error' ? red('error') : yellow('warn ');
      process.stdout.write(`  ${tag}${at} ${f.message}\n`);
    }
  }

  process.stdout.write(`\n${dim('checked')} ${serverIds.size} servers · ${workflowIds.size} workflows · ${seenProjectIds.size} projects · ${issues.length} issues · ${snapshotCount} snapshots\n`);
}

if (errors.length === 0 && warnings.length === 0) {
  process.stdout.write(`${green('✓')} validate passed\n`);
} else if (errors.length === 0) {
  process.stdout.write(`${green('✓')} validate passed with ${yellow(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`)}\n`);
} else {
  process.stdout.write(`${red('✗')} validate failed: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}\n`);
}

process.exit(errors.length === 0 ? 0 : 1);
