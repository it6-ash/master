#!/usr/bin/env node
/**
 * npm run admin — serve the dashboard behind a Google sign-in, plus the admin
 * panel that writes the registry.
 *
 *   npm run admin                  loopback :4179, behind nginx in production
 *   npm run admin -- --port 4179
 *   npm run admin -- --host 0.0.0.0   see the warning below before you do this
 *
 * This is the one piece of Estate that is a server rather than a build step,
 * and it exists for two reasons the static file cannot cover: the page needed
 * to stop being readable by anyone who resolves the hostname, and adding a
 * workflow or a report recipient needed to not require an SSH session.
 *
 * What it serves:
 *
 *   /                 dist/index.html, the same file nginx used to serve
 *   /admin            the panel: workflows, recipients, schedule, collector
 *   /login /logout    Google OAuth, email allowlist. See src/auth.js
 *   /api/*            the writes, CSRF-checked, allowlist-checked
 *
 * Writes land in config/n8n.json, the git-ignored override, NOT in the tracked
 * config/n8n.example.json. deploy/pull.sh checks out config/ from origin on
 * every pass, so a workflow added here through the panel would be wiped within
 * six hours if it went into the tracked file. The override is untracked, so
 * git cannot touch it, and the registry merge already lets it win. The panel
 * offers the merged registry as a download so a change can be promoted into
 * the repo deliberately.
 *
 * SECURITY. Bind loopback and put nginx or the tunnel in front. Nothing here
 * trusts a header for identity — the session is an HMAC the server minted —
 * but binding to 0.0.0.0 publishes an endpoint that can start processes, and
 * the only thing between it and the internet would be Google's OAuth consent.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ROOT, abs, rel, exists, readJson } from './lib/fsx.js';
import {
  oauthConfig, startLogin, exchangeCode, verifyIdToken, issueSession, sessionFrom,
  isAllowed, csrfOk, cookie, parseCookies, unsign, safeReturnTo,
  SESSION_COOKIE, STATE_COOKIE, DEFAULT_ADMIN_PORT,
} from './auth.js';
import { loadRegistry, resolveRegistry, parseWorkflowRef, WORKFLOW_ID_RE, instanceForHost } from './n8n/registry.js';
import { loadAllStores } from './n8n/collect.js';
import { escapeHtml } from './render/markdown.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const PORT = Number(flag('port', process.env.ADMIN_PORT ?? DEFAULT_ADMIN_PORT));
const HOST = flag('host', process.env.ADMIN_HOST ?? '127.0.0.1');
const LOCAL_CONFIG = ['config', 'n8n.json'];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

/* ------------------------------------------------------------- plumbing */

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  // The dashboard inlines its own CSS and script and loads nothing from a
  // network, which is what makes a strict policy possible at all here.
  // 'unsafe-inline' is required because that is precisely what inlined means.
  'content-security-policy': "default-src 'none'; img-src 'self' data: https://lh3.googleusercontent.com;"
    + " style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; form-action 'self';"
    + " base-uri 'none'; frame-ancestors 'none'",
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(body);
}

const json = (res, code, value, headers = {}) => send(res, code, JSON.stringify(value, null, 2), {
  'content-type': 'application/json; charset=utf-8', ...headers,
});

function readBody(req, { limit = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // A body cap, because an unbounded read on a public-ish endpoint is a
      // memory exhaustion away from taking the box down.
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readForm(req) {
  const raw = await readBody(req);
  const type = String(req.headers['content-type'] ?? '');
  if (type.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/* --------------------------------------------------------- config writes */

/** The git-ignored override, which is the only file this server writes. */
function loadLocal() {
  const got = readJson(abs(...LOCAL_CONFIG));
  return got.ok ? got.value : {};
}

function saveLocal(next) {
  const file = abs(...LOCAL_CONFIG);
  // Write-then-rename: a half-written config read by the next collector pass
  // is a registry with no workflows in it, which reads as "nothing to monitor".
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** One address per line, comma, or semicolon. Invalid ones are named, not dropped. */
export function parseEmails(input) {
  const seen = new Set();
  const bad = [];
  for (const raw of String(input ?? '').split(/[\s,;]+/)) {
    const value = raw.trim().toLowerCase();
    if (!value) continue;
    if (!EMAIL_RE.test(value)) { bad.push(value); continue; }
    seen.add(value);
  }
  return { emails: [...seen], invalid: bad };
}

const int = (value, { min, max, fallback = null }) => {
  if (value === '' || value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * Turn a panel submission into a registry entry, refusing anything that would
 * put a bad value into the config.
 *
 * Every field is bounded. The alternative is a typo in a web form writing
 * `expectedIntervalMin: 0`, which makes the workflow permanently stale and
 * mails everybody about it every six hours.
 */
export function entryFromForm(form, { instances }) {
  const ref = parseWorkflowRef(form.url ?? form.id ?? '');
  if (!ref.ok) return { ok: false, error: ref.error };

  let instance = String(form.instance ?? '').trim();
  if (!instance) {
    const matched = instanceForHost(ref.host, instances);
    if (matched) instance = matched.id;
    else if (!ref.host && Object.keys(instances).length === 1) [instance] = Object.keys(instances);
  }
  if (!instances[instance]) {
    return {
      ok: false,
      error: instance
        ? `"${instance}" is not a configured n8n instance`
        : `pick the n8n instance — ${ref.host ? `${ref.host} is not one of the configured hosts` : 'a bare id does not say which'}`,
    };
  }

  const { emails: _ignored } = { emails: [] };
  const entry = { id: ref.id, instance, monitoring: form.monitoring !== 'off' && form.monitoring !== false };

  const name = String(form.name ?? '').trim().slice(0, 120);
  if (name) entry.name = name;
  const description = String(form.description ?? '').trim().slice(0, 400);
  if (description) entry.description = description;
  const project = String(form.project ?? '').trim().slice(0, 60);
  if (project) entry.project = project;
  if (ref.origin) entry.url = `${ref.origin}/workflow/${ref.id}`;
  if (form.reporting === 'off' || form.reporting === false) entry.reporting = false;

  const interval = int(form.expectedIntervalMin, { min: 1, max: 60 * 24 * 90, fallback: null });
  if (interval !== null) entry.expectedIntervalMin = interval;
  const stale = int(form.staleAfterMin, { min: 1, max: 60 * 24 * 180, fallback: null });
  if (stale !== null) entry.staleAfterMin = stale;
  const minItems = int(form.minimumItems, { min: 0, max: 10_000_000, fallback: null });
  if (minItems !== null) entry.minimumItems = minItems;
  const drop = int(form.anomalyDropPct, { min: 1, max: 99, fallback: null });
  if (drop !== null) entry.anomalyDropPct = drop;
  const streak = int(form.consecutiveFailures, { min: 1, max: 100, fallback: null });
  if (streak !== null) entry.consecutiveFailures = streak;

  // Checkpoints are n8n NODE NAMES and must match the editor exactly, so they
  // are only trimmed, never case-folded or slugged.
  const checkpoints = String(form.checkpoints ?? '')
    .split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 24);
  if (checkpoints.length) entry.checkpoints = [...new Set(checkpoints)];

  return { ok: true, entry };
}

/* ------------------------------------------------------- background jobs */

/**
 * The last run of each command, so the panel can show what happened without
 * holding an HTTP request open for the length of a collection pass.
 */
const jobs = new Map();

function runJob(name, argv) {
  const current = jobs.get(name);
  if (current?.running) return { started: false, reason: 'already running' };

  const job = { running: true, startedAt: new Date().toISOString(), output: '', code: null };
  jobs.set(name, job);

  const child = spawn(process.execPath, argv, {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const take = (chunk) => {
    // Bounded: a runaway command must not grow this process's heap until the
    // box notices.
    job.output = (job.output + chunk).slice(-8000);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.on('error', (e) => { job.running = false; job.code = 1; take(`\n${e.message}`); });
  child.on('close', (code) => {
    job.running = false;
    job.code = code ?? 1;
    job.finishedAt = new Date().toISOString();
  });

  return { started: true };
}

const jobState = () => Object.fromEntries([...jobs.entries()].map(([name, j]) => [name, {
  running: j.running, code: j.code, startedAt: j.startedAt, finishedAt: j.finishedAt ?? null,
  output: j.output.split('\n').slice(-14).join('\n'),
}]));

/* ------------------------------------------------------------ the panel */

const field = (label, name, value, { type = 'text', hint = null, placeholder = '', attrs = '' } = {}) => `
  <label class="af">
    <span class="af-label">${escapeHtml(label)}</span>
    <input class="af-input" type="${type}" name="${escapeHtml(name)}" value="${escapeHtml(String(value ?? ''))}"
      placeholder="${escapeHtml(placeholder)}" ${attrs}>
    ${hint ? `<span class="af-hint">${hint}</span>` : ''}
  </label>`;

function adminPage(session, { registry, stores, notice = null, error = null, css }) {
  const resolved = resolveRegistry(registry);
  const local = loadLocal();
  const byKey = new Map(stores.map((s) => [`${s.instance}__${s.workflowId}`, s]));
  const report = resolved.report ?? {};

  const instanceOptions = Object.keys(resolved.instances)
    .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');

  const row = (w) => {
    const store = byKey.get(w.key);
    const rows = store?.rows?.length ?? 0;
    const last = store?.sync?.lastExecutionAt ?? null;
    const isLocal = (local.workflows ?? []).some((x) => x.id === w.id && x.instance === w.instance);
    return `<details class="aw">
      <summary>
        <span class="dot dot--${w.monitoring ? 'live' : 'idle'}"></span>
        <strong>${escapeHtml(w.name ?? w.id)}</strong>
        <span class="af-hint">${escapeHtml(w.instance)} · ${escapeHtml(w.id)}</span>
        <span class="aw-meta">${rows} rows${last ? ` · last ${escapeHtml(last.replace('T', ' ').slice(0, 16))}` : ' · never run'}
          ${isLocal ? '' : '<span class="pill">from the repo</span>'}</span>
      </summary>
      <form method="POST" action="/api/workflows" class="af-grid">
        <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
        <input type="hidden" name="url" value="${escapeHtml(w.id)}">
        <input type="hidden" name="instance" value="${escapeHtml(w.instance)}">
        ${field('Name', 'name', w.name)}
        ${field('Estate project', 'project', w.project, { hint: 'an id under content/projects/, so the analytics join the project hierarchy' })}
        ${field('Description', 'description', w.description)}
        ${field('Expected every (minutes)', 'expectedIntervalMin', w.expectedIntervalMin, { type: 'number', attrs: 'min="1"', hint: 'leave empty for a webhook-driven workflow — it is not stale because nobody filled the form' })}
        ${field('Stale after (minutes)', 'staleAfterMin', w.staleAfterMin, { type: 'number', attrs: 'min="1"', hint: 'empty derives twice the interval plus a quarter hour' })}
        ${field('Minimum items a good run produces', 'minimumItems', w.minimumItems, { type: 'number', attrs: 'min="0"', hint: 'above 0 turns on the zero-data check: succeeded, but moved nothing' })}
        ${field('Anomaly drop %', 'anomalyDropPct', w.anomalyDropPct, { type: 'number', attrs: 'min="1" max="99"' })}
        ${field('Consecutive failures before CRITICAL', 'consecutiveFailures', w.consecutiveFailures, { type: 'number', attrs: 'min="1"' })}
        <label class="af af--wide">
          <span class="af-label">Checkpoints — n8n node names, one per line</span>
          <textarea class="af-input" name="checkpoints" rows="3"
            placeholder="Fetch from Cratio&#10;Meta CAPI">${escapeHtml((w.checkpoints ?? []).join('\n'))}</textarea>
          <span class="af-hint">These are the stages counted separately and bucketed by hour, which is what answers
          "how much went from Cratio to Meta, and in which hour". Spelled exactly as in the n8n editor.</span>
        </label>
        <label class="af af--check"><input type="checkbox" name="monitoring" ${w.monitoring ? 'checked' : ''}> Collect executions</label>
        <label class="af af--check"><input type="checkbox" name="reporting" ${w.reporting === false ? '' : 'checked'}> Include in the email report</label>
        <div class="af-actions">
          <button class="chip chip--go" type="submit">Save</button>
          <button class="chip chip--bad" type="submit" formaction="/api/workflows/delete"
            onclick="return confirm('Stop monitoring ${escapeHtml(String(w.name ?? w.id)).replace(/'/g, '')}? Its collected history in data/runs is left alone.')">Stop monitoring</button>
        </div>
      </form>
    </details>`;
  };

  return `<!doctype html>
<html lang="en" data-theme="dark"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>KW Estate — admin</title>
<style>${css}
.awrap { max-width: 1000px; margin: 0 auto; padding: var(--pad-page); }
.ahead { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 22px; }
.ahead .brand { margin-right: auto; }
.anote { padding: 11px 14px; border-radius: var(--r-inner); margin-bottom: 18px; font-size: var(--fs-meta); }
.anote--ok { background: color-mix(in srgb, var(--ok) 14%, transparent); color: var(--ok); }
.anote--bad { background: color-mix(in srgb, var(--critical) 14%, transparent); color: var(--critical); }
.acard { background: linear-gradient(160deg, var(--surface-start), var(--surface-end));
  border: 1px solid var(--border); border-radius: var(--r-card); padding: var(--pad-card); margin-bottom: var(--gap-lg); }
.acard > h2 { font-size: var(--fs-title); margin: 0 0 4px; }
.acard > p { color: var(--ink-2); font-size: var(--fs-meta); margin: 0 0 16px; }
.af-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--gap); align-items: start; }
.af { display: grid; gap: 4px; }
.af--wide { grid-column: 1 / -1; }
.af--check { display: flex; align-items: center; gap: 8px; font-size: var(--fs-meta); color: var(--ink-2); min-height: var(--touch); }
.af-label { font-size: var(--fs-meta); color: var(--ink-2); }
.af-input { background: var(--sunken); color: var(--ink); border: 1px solid var(--border);
  border-radius: var(--r-sm); padding: 9px 10px; font: var(--fs-body) var(--mono); min-height: 38px; width: 100%; }
.af-input:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-color: var(--primary); }
.af-hint { font-size: 11px; color: var(--ink-3); line-height: 1.45; }
.af-actions { grid-column: 1 / -1; display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.chip--go { border-color: var(--primary); color: var(--primary); }
.chip--bad { border-color: var(--critical); color: var(--critical); }
.aw { border: 1px solid var(--border); border-radius: var(--r-inner); margin-bottom: 8px; }
.aw > summary { cursor: pointer; padding: 11px 13px; display: flex; align-items: center; gap: 9px;
  flex-wrap: wrap; list-style: none; min-height: var(--touch); font-size: var(--fs-meta); }
.aw > summary::-webkit-details-marker { display: none; }
.aw > summary::before { content: "\\25B8"; color: var(--ink-3); font-size: 10px; }
.aw[open] > summary::before { content: "\\25BE"; }
.aw > form { padding: 0 13px 15px; border-top: 1px solid var(--border); padding-top: 14px; }
.aw-meta { margin-left: auto; font: 11px var(--mono); color: var(--ink-3); }
.ajob { background: var(--sunken); border-radius: var(--r-sm); padding: 10px 12px; margin-top: 10px;
  font: 11px/1.6 var(--mono); color: var(--ink-2); white-space: pre-wrap; max-height: 220px; overflow: auto; }
.auser { display: flex; align-items: center; gap: 8px; font-size: var(--fs-meta); color: var(--ink-2); }
.auser img { width: 26px; height: 26px; border-radius: 50%; }
</style></head>
<body><div class="awrap">

<div class="ahead">
  <div class="brand">KW Estate <span>· admin</span></div>
  <div class="auser">${session.picture ? `<img src="${escapeHtml(session.picture)}" alt="">` : ''}${escapeHtml(session.email)}</div>
  <a class="chip" href="/">Dashboard</a>
  <a class="chip" href="/logout">Sign out</a>
</div>

${notice ? `<div class="anote anote--ok">${escapeHtml(notice)}</div>` : ''}
${error ? `<div class="anote anote--bad">${escapeHtml(error)}</div>` : ''}
${resolved.errors.length ? `<div class="anote anote--bad">${resolved.errors.map(escapeHtml).join('<br>')}</div>` : ''}

<section class="acard">
  <h2>Connect a workflow</h2>
  <p>Paste the URL from the n8n editor with the workflow open. The id is parsed out of it and checked against the
  instance before anything is written, so a mistyped id is refused here rather than showing up later as a workflow
  that has simply never run.</p>
  <form method="POST" action="/api/workflows" class="af-grid">
    <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
    <label class="af af--wide">
      <span class="af-label">n8n workflow URL</span>
      <input class="af-input" type="text" name="url" required
        placeholder="https://n8n.srv1340120.hstgr.cloud/workflow/S3Yx1gWQAJYy7mYM">
      <span class="af-hint">Also accepts a project-scoped URL, an execution URL, or a bare workflow id.</span>
    </label>
    <label class="af">
      <span class="af-label">n8n instance</span>
      <select class="af-input" name="instance"><option value="">from the URL host</option>${instanceOptions}</select>
    </label>
    ${field('Name', 'name', '', { hint: 'leave empty to take the name n8n reports' })}
    ${field('Estate project', 'project', '', { placeholder: 'yamini' })}
    ${field('Expected every (minutes)', 'expectedIntervalMin', '', { type: 'number', attrs: 'min="1"', placeholder: '60' })}
    ${field('Minimum items', 'minimumItems', '', { type: 'number', attrs: 'min="0"', placeholder: '1' })}
    <label class="af af--wide">
      <span class="af-label">Checkpoints — n8n node names, one per line</span>
      <textarea class="af-input" name="checkpoints" rows="3" placeholder="Fetch from Cratio&#10;Meta CAPI"></textarea>
    </label>
    <div class="af-actions"><button class="chip chip--go" type="submit">Connect and collect</button></div>
  </form>
</section>

<section class="acard">
  <h2>Monitored workflows <span class="af-hint">${resolved.workflows.length}</span></h2>
  <p>Entries marked <span class="pill">from the repo</span> come from the tracked
  <code>config/n8n.example.json</code>. Saving one here writes it to the git-ignored override instead, because
  <code>deploy/pull.sh</code> checks out <code>config/</code> from origin on every pass and would otherwise wipe it
  within six hours.</p>
  ${resolved.workflows.length ? resolved.workflows.map(row).join('') : '<div class="empty">Nothing connected yet.</div>'}
</section>

<section class="acard">
  <h2>Email the data</h2>
  <p>One digest a day at the time below, in that timezone rather than the server's — this box runs Etc/UTC, where a
  bare 09:40 would mail at 15:10 in Delhi. Alerts are separate and go the moment something breaks, held per workflow
  per problem for the cooldown so one broken workflow cannot fill an inbox.</p>
  <form method="POST" action="/api/notifications" class="af-grid">
    <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
    <label class="af af--wide">
      <span class="af-label">Recipients — one per line</span>
      <textarea class="af-input" name="notify" rows="4">${escapeHtml((report.notify ?? []).join('\n'))}</textarea>
      <span class="af-hint">Merged as a union with the tracked config, so adding somebody here never silently
      removes the people listed in the repo.</span>
    </label>
    <label class="af af--wide">
      <span class="af-label">CC — one per line</span>
      <textarea class="af-input" name="cc" rows="2">${escapeHtml((report.cc ?? []).join('\n'))}</textarea>
    </label>
    <label class="af">
      <span class="af-label">Frequency</span>
      <select class="af-input" name="frequency">
        <option value="daily" ${report.frequency === 'weekly' ? '' : 'selected'}>Daily</option>
        <option value="weekly" ${report.frequency === 'weekly' ? 'selected' : ''}>Weekly</option>
      </select>
    </label>
    ${field('Send at (HH:MM)', 'reportAt', report.reportAt ?? '09:40', { placeholder: '09:40' })}
    ${field('Timezone', 'timezone', report.timezone ?? 'Asia/Kolkata')}
    <label class="af">
      <span class="af-label">Weekly on</span>
      <select class="af-input" name="weeklyOn">
        ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<option ${(report.weeklyOn ?? 'Mon') === d ? 'selected' : ''}>${d}</option>`).join('')}
      </select>
    </label>
    ${field('n8n report webhook', 'webhook', report.webhook ?? '', { hint: 'loopback, so a broken certificate on n8n\'s hostname cannot silence the alert that would have reported it' })}
    ${field('Alert cooldown (minutes)', 'cooldownMin', report.alerts?.cooldownMin ?? 360, { type: 'number', attrs: 'min="5"' })}
    ${field('Minimum anomaly % to alert on', 'minAnomalyPct', report.alerts?.minAnomalyPct ?? 40, { type: 'number', attrs: 'min="1" max="99"' })}
    <label class="af af--check"><input type="checkbox" name="alertFailure" ${report.alerts?.failure === false ? '' : 'checked'}> Alert on repeated failures</label>
    <label class="af af--check"><input type="checkbox" name="alertStale" ${report.alerts?.stale === false ? '' : 'checked'}> Alert when a workflow stops running</label>
    <label class="af af--check"><input type="checkbox" name="alertAnomaly" ${report.alerts?.anomaly === false ? '' : 'checked'}> Alert on a data-volume anomaly</label>
    <label class="af af--check"><input type="checkbox" name="alertZeroData" ${report.alerts?.zeroData === false ? '' : 'checked'}> Alert when a run succeeds with 0 items</label>
    <div class="af-actions"><button class="chip chip--go" type="submit">Save</button></div>
  </form>
  <form method="POST" action="/api/report" style="margin-top:10px">
    <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
    <button class="chip" type="submit">Send the digest now</button>
  </form>
</section>

<section class="acard">
  <h2>Who can sign in <span class="af-hint">${resolved.admin.allowedEmails.length}</span></h2>
  <p>Google provides the identity; this list is the authorisation, and it is re-checked on every request so removing
  somebody takes effect immediately. An empty list denies everyone. You cannot remove your own address here — locking
  yourself out of the only way in would need an SSH session to undo.</p>
  <form method="POST" action="/api/access" class="af-grid">
    <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
    <label class="af af--wide">
      <span class="af-label">Allowed email addresses — one per line</span>
      <textarea class="af-input" name="allowedEmails" rows="4">${escapeHtml(resolved.admin.allowedEmails.join('\n'))}</textarea>
    </label>
    ${field('Or allow a whole domain', 'allowedDomain', resolved.admin.allowedDomain ?? '', { placeholder: 'kwgroup.in', hint: 'much wider than a list of people. Leave empty unless you mean it.' })}
    <div class="af-actions"><button class="chip chip--go" type="submit">Save</button></div>
  </form>
</section>

<section class="acard">
  <h2>Collector</h2>
  <p>Collection normally runs on the 6-hourly timer. These run it now, in the background, and report what happened.</p>
  <div class="af-actions">
    <form method="POST" action="/api/sync"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
      <button class="chip chip--go" type="submit">Collect and rebuild</button></form>
    <form method="POST" action="/api/build"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
      <button class="chip" type="submit">Rebuild the page only</button></form>
    <a class="chip" href="/api/registry">Download the merged registry</a>
    <a class="chip" href="/admin">Refresh</a>
  </div>
  ${Object.entries(jobState()).map(([name, j]) => `<div class="ajob"><strong>${escapeHtml(name)}</strong> — ${j.running ? 'running' : `finished, exit ${j.code}`}
${escapeHtml(j.output || '(no output yet)')}</div>`).join('')}
</section>

</div></body></html>`;
}

function loginPage(config, { error = null, returnTo = '/', css }) {
  const blocked = config.missing.length;
  return `<!doctype html>
<html lang="en" data-theme="dark"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>KW Estate — sign in</title>
<style>${css}
.lwrap { min-height: 100vh; display: grid; place-items: center; padding: var(--pad-page); }
.lcard { max-width: 430px; background: linear-gradient(160deg, var(--surface-start), var(--surface-end));
  border: 1px solid var(--border); border-radius: var(--r-card); padding: 30px; }
.lcard h1 { font-size: 21px; margin: 0 0 6px; }
.lcard p { color: var(--ink-2); font-size: var(--fs-meta); line-height: 1.6; }
.lbtn { display: inline-flex; align-items: center; gap: 10px; margin: 20px 0 0; padding: 11px 18px;
  background: var(--sunken); color: var(--ink); border: 1px solid var(--border); border-radius: var(--r-sm);
  text-decoration: none; font-size: var(--fs-body); font-weight: 560; min-height: var(--touch); }
.lbtn:hover { border-color: var(--primary); }
.lbad { background: color-mix(in srgb, var(--critical) 14%, transparent); color: var(--critical);
  padding: 11px 13px; border-radius: var(--r-inner); font-size: var(--fs-meta); margin-bottom: 16px; }
</style></head>
<body><div class="lwrap"><div class="lcard">
  <h1>KW Estate</h1>
  <p>Every server, project and workflow KW Group runs — and what the n8n automations are doing with the data.</p>
  ${error ? `<div class="lbad" style="margin-top:16px">${escapeHtml(error)}</div>` : ''}
  ${blocked
    ? `<div class="lbad" style="margin-top:16px">Sign-in is not configured on this box:
       ${config.missing.map((m) => `<code>$${escapeHtml(m)}</code>`).join(', ')} ${config.missing.length === 1 ? 'is' : 'are'}
       not set in <code>/etc/kw-estate.env</code>. Create an OAuth 2.0 Web client in the Google Cloud console with
       <code>${escapeHtml(config.redirectUri)}</code> as an authorised redirect URI.</div>`
    : `<a class="lbtn" href="/auth/google?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-4H24v8h12c-.2 2-1.5 5-4.8 7l-.1.4 6.9 5.3.5.1C42.7 36.8 45 31 45 24z"/><path fill="#34A853" d="M24 46c6 0 11-2 14.6-5.4l-7-5.4C29.8 36.5 27.2 37.5 24 37.5c-5.8 0-10.7-3.8-12.5-9.1l-.4.1-7 5.4-.2.4C7.6 41.2 15.2 46 24 46z"/><path fill="#FBBC05" d="M11.5 28.4c-.5-1.4-.8-2.9-.8-4.4s.3-3 .7-4.4v-.5l-7.2-5.5-.3.1A22 22 0 0 0 2 24c0 3.5.9 6.9 2.4 9.9l7.1-5.5z"/><path fill="#EA4335" d="M24 10.5c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 4.3 30 2 24 2 15.2 2 7.6 6.8 4.4 14.1l7.1 5.5C13.3 14.3 18.2 10.5 24 10.5z"/></svg>
        Sign in with Google
      </a>
      <p style="margin-top:18px">Access is by named address. A valid Google login by an address that is not on the
      list is refused, and nothing on this page is readable until it passes.</p>`}
</div></div></body></html>`;
}

/* -------------------------------------------------------------- routing */

async function handle(req, res, { css }) {
  const url = new URL(req.url, `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  const registry = loadRegistry();
  const admin = resolveRegistry(registry).admin;
  const config = { ...oauthConfig(process.env, { baseUrl: process.env.ADMIN_BASE_URL }), allowedDomain: admin.allowedDomain };
  const session = sessionFrom(req, config, admin);

  /* ---- public: the login page and the OAuth dance only */

  if (url.pathname === '/login') {
    return send(res, 200, loginPage(config, { returnTo: url.searchParams.get('returnTo') ?? '/', css }));
  }

  if (url.pathname === '/logout') {
    return send(res, 302, '', {
      location: '/login',
      'set-cookie': cookie(SESSION_COOKIE, '', { clear: true, secure: config.secure }),
    });
  }

  if (url.pathname === '/auth/google') {
    if (config.missing.length) return send(res, 503, loginPage(config, { css }));
    const { url: target, stateCookie } = startLogin(config, { returnTo: url.searchParams.get('returnTo') ?? '/' });
    return send(res, 302, '', { location: target, 'set-cookie': stateCookie });
  }

  if (url.pathname === '/auth/callback') {
    if (config.missing.length) return send(res, 503, loginPage(config, { css }));

    const fail = (message) => send(res, 403, loginPage(config, { error: message, css }), {
      'set-cookie': cookie(STATE_COOKIE, '', { clear: true, secure: config.secure }),
    });

    if (url.searchParams.get('error')) {
      return fail(`Google returned "${url.searchParams.get('error')}". Nothing was signed in.`);
    }

    const state = unsign(url.searchParams.get('state'), config.sessionSecret);
    const nonce = parseCookies(req.headers.cookie)[STATE_COOKIE];
    // The signature proves we minted the state; the cookie proves the same
    // browser is redeeming it. Without the second check an attacker can
    // complete a login into somebody else's session.
    if (!state || !nonce || state.n !== nonce) {
      return fail('That sign-in link did not come from this browser, or it has expired. Try again.');
    }

    const code = url.searchParams.get('code');
    if (!code) return fail('Google sent no authorization code.');

    const exchanged = await exchangeCode(code, config);
    if (!exchanged.ok) return fail(exchanged.error);

    const identity = await verifyIdToken(exchanged.idToken, config);
    if (!identity.ok) return fail(identity.error);

    if (!isAllowed(identity.email, admin)) {
      // Named, deliberately. "Not authorised" with no address sends people to
      // ask IT why their login is broken when they are simply signed into the
      // wrong one of their three Google accounts.
      return fail(`${identity.email} is not on the access list for this dashboard.`
        + ' If that is the wrong account, sign out of Google and try again.');
    }

    const issued = issueSession(identity.email, config, { name: identity.name });
    return send(res, 302, '', {
      location: safeReturnTo(state.r),
      'set-cookie': [
        issued.setCookie,
        cookie(STATE_COOKIE, '', { clear: true, secure: config.secure }),
      ],
    });
  }

  /* ---- everything past here needs a session */

  if (!session) {
    if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'not signed in' });
    return send(res, 302, '', { location: `/login?returnTo=${encodeURIComponent(url.pathname + url.search)}` });
  }

  if (url.pathname === '/api/registry') {
    return json(res, 200, loadRegistry(), {
      'content-disposition': 'attachment; filename="kw-estate-n8n-registry.json"',
    });
  }

  if (url.pathname === '/admin' && req.method === 'GET') {
    return send(res, 200, adminPage(session, {
      registry,
      stores: loadAllStores(),
      notice: url.searchParams.get('ok'),
      error: url.searchParams.get('err'),
      css,
    }));
  }

  /* ---- writes */

  if (req.method === 'POST') {
    let form;
    try {
      form = await readForm(req);
    } catch (e) {
      return json(res, 413, { error: e.message });
    }
    if (!csrfOk(session, form.csrf)) {
      return json(res, 403, { error: 'this form is stale — reload /admin and try again' });
    }

    const back = (ok, message) => send(res, 303, '', {
      location: `/admin?${ok ? 'ok' : 'err'}=${encodeURIComponent(String(message).slice(0, 300))}`,
    });

    if (url.pathname === '/api/workflows') {
      const resolved = resolveRegistry(registry);
      const built = entryFromForm(form, { instances: resolved.instances });
      if (!built.ok) return back(false, built.error);

      const local = loadLocal();
      local.workflows = local.workflows ?? [];
      const at = local.workflows.findIndex((w) => w.id === built.entry.id && w.instance === built.entry.instance);
      if (at === -1) local.workflows.push(built.entry);
      else local.workflows[at] = { ...local.workflows[at], ...built.entry };
      saveLocal(local);

      runJob('collect', [abs('src', 'n8n', 'collect.js'), built.entry.id]);
      return back(true, `${at === -1 ? 'Connected' : 'Updated'} ${built.entry.name ?? built.entry.id}. Collecting now.`);
    }

    if (url.pathname === '/api/workflows/delete') {
      const id = String(form.url ?? '').trim();
      if (!WORKFLOW_ID_RE.test(id)) return back(false, 'that is not a workflow id');
      const local = loadLocal();
      const before = (local.workflows ?? []).length;
      local.workflows = (local.workflows ?? []).filter((w) => w.id !== id);
      // An entry that lives in the TRACKED file cannot be deleted from here —
      // the next pull would bring it straight back. Say so rather than
      // appearing to work and then silently reverting.
      const inRepo = (readJson(abs('config', 'n8n.example.json')).value?.workflows ?? [])
        .some((w) => w.id === id);
      if (before === local.workflows.length && inRepo) {
        local.workflows.push({ id, instance: String(form.instance ?? ''), monitoring: false });
        saveLocal(local);
        return back(true, `${id} is registered in the repo, so it has been switched off here instead.`
          + ' Remove it from config/n8n.example.json to drop it entirely.');
      }
      saveLocal(local);
      return back(true, `Stopped monitoring ${id}. Its collected history in data/runs is untouched.`);
    }

    if (url.pathname === '/api/notifications') {
      const notify = parseEmails(form.notify);
      const cc = parseEmails(form.cc);
      if (notify.invalid.length || cc.invalid.length) {
        return back(false, `not an email address: ${[...notify.invalid, ...cc.invalid].slice(0, 3).join(', ')}`);
      }
      const at = String(form.reportAt ?? '').trim();
      if (at && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return back(false, `"${at}" is not a time like 09:40`);

      const tz = String(form.timezone ?? '').trim() || 'Asia/Kolkata';
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
      } catch {
        return back(false, `"${tz}" is not an IANA timezone. Asia/Kolkata, Europe/London, UTC.`);
      }

      const webhook = String(form.webhook ?? '').trim();
      if (webhook && !/^https?:\/\//.test(webhook)) return back(false, 'the webhook must be an http or https URL');

      const local = loadLocal();
      local.report = {
        ...(local.report ?? {}),
        notify: notify.emails,
        cc: cc.emails,
        frequency: form.frequency === 'weekly' ? 'weekly' : 'daily',
        reportAt: at || '09:40',
        timezone: tz,
        weeklyOn: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(form.weeklyOn) ? form.weeklyOn : 'Mon',
        alerts: {
          ...(local.report?.alerts ?? {}),
          failure: form.alertFailure === 'on',
          stale: form.alertStale === 'on',
          anomaly: form.alertAnomaly === 'on',
          zeroData: form.alertZeroData === 'on',
          cooldownMin: int(form.cooldownMin, { min: 5, max: 10080, fallback: 360 }),
          minAnomalyPct: int(form.minAnomalyPct, { min: 1, max: 99, fallback: 40 }),
        },
      };
      if (webhook) local.report.webhook = webhook;
      saveLocal(local);
      return back(true, `Saved. ${notify.emails.length} recipient${notify.emails.length === 1 ? '' : 's'}`
        + ` — merged as a union with the ${(readJson(abs('config', 'n8n.example.json')).value?.report?.notify ?? []).length} in the repo.`);
    }

    if (url.pathname === '/api/access') {
      const parsed = parseEmails(form.allowedEmails);
      if (parsed.invalid.length) return back(false, `not an email address: ${parsed.invalid.slice(0, 3).join(', ')}`);

      const domain = String(form.allowedDomain ?? '').trim().toLowerCase().replace(/^@/, '');
      if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return back(false, `"${domain}" is not a domain`);

      // You cannot remove yourself. Saving a list without your own address
      // locks the only door and the fix is an SSH session, which is exactly
      // the thing this panel exists to avoid needing.
      const keeps = isAllowed(session.email, { allowedEmails: parsed.emails, allowedDomain: domain || null });
      if (!keeps) {
        return back(false, `that list does not include ${session.email}, so saving it would lock you out.`
          + ' Add your own address back, or edit config/n8n.example.json over SSH.');
      }

      const local = loadLocal();
      local.admin = { allowedEmails: parsed.emails, allowedDomain: domain || null };
      saveLocal(local);
      return back(true, `Saved. ${parsed.emails.length} address${parsed.emails.length === 1 ? '' : 'es'}`
        + `${domain ? `, plus anyone at ${domain}` : ''}. Removing somebody from the repo's own list still needs a commit.`);
    }

    if (url.pathname === '/api/sync') {
      const started = runJob('collect-and-build', [abs('src', 'sync.js')]);
      return back(started.started, started.started
        ? 'Collecting from every server and rebuilding. Refresh to see the output.'
        : 'A collection pass is already running.');
    }

    if (url.pathname === '/api/build') {
      const started = runJob('build', [abs('src', 'build.js')]);
      return back(started.started, started.started ? 'Rebuilding the page.' : 'A build is already running.');
    }

    if (url.pathname === '/api/report') {
      const started = runJob('report', [abs('src', 'n8n', 'report.js'), '--force']);
      return back(started.started, started.started ? 'Sending the digest.' : 'A report is already being sent.');
    }

    return json(res, 404, { error: `no such endpoint: ${url.pathname}` });
  }

  /* ---- the dashboard itself, and anything else under dist/ */

  let pathname = decodeURIComponent(url.pathname);
  // The route the brief asked for. `npm run build` writes dist/workflows.html,
  // so this is a name for a static file rather than a server-rendered view —
  // the page survives a restart of this process and still opens from file://.
  if (pathname === '/workflows/analytics' || pathname === '/workflows') pathname = '/workflows.html';
  if (pathname === '/' || pathname.endsWith('/')) pathname += 'index.html';
  const root = abs('dist');
  const target = path.resolve(root, `.${pathname}`);
  // The same containment serve.js uses. A session is not permission to read
  // /etc/kw-estate.env via ../../.
  if (!target.startsWith(root)) return send(res, 403, 'Forbidden', { 'content-type': 'text/plain' });
  if (!exists(target) || !fs.statSync(target).isFile()) {
    return send(res, 404, `Not found: ${escapeHtml(pathname)}. Run \`npm run build\`.`, { 'content-type': 'text/plain; charset=utf-8' });
  }

  res.writeHead(200, {
    'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  fs.createReadStream(target).pipe(res);
  return undefined;
}

/* ----------------------------------------------------------------- main */

function main() {
  const css = exists(abs('src', 'render', 'styles.css')) ? fs.readFileSync(abs('src', 'render', 'styles.css'), 'utf8') : '';
  const config = oauthConfig();

  const server = http.createServer((req, res) => {
    handle(req, res, { css }).catch((e) => {
      // Never echo an exception to the browser: a stack trace names paths and,
      // on a config error, sometimes the value that was wrong.
      process.stderr.write(`${req.method} ${req.url} — ${e.stack ?? e.message}\n`);
      if (!res.headersSent) send(res, 500, 'Something went wrong. Check the server log.', { 'content-type': 'text/plain' });
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      process.stderr.write(`Port ${PORT} is already in use. npm run admin -- --port ${PORT + 1}\n`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(PORT, HOST, () => {
    process.stdout.write(`\n  KW Estate admin  →  http://${HOST}:${PORT}\n`);
    process.stdout.write(`  dashboard ${rel(abs('dist', 'index.html'))}${exists(abs('dist', 'index.html')) ? '' : '  (missing — run npm run build)'}\n`);
    if (config.missing.length) {
      process.stdout.write(`  ! sign-in disabled: ${config.missing.map((m) => `$${m}`).join(', ')} not set.`
        + ' Nothing is served until they are.\n');
    } else {
      process.stdout.write(`  redirect URI for the Google OAuth client: ${config.redirectUri}\n`);
    }
    const { admin } = resolveRegistry();
    process.stdout.write(`  ${admin.allowedEmails.length} address(es) allowed`
      + `${admin.allowedDomain ? ` plus anyone at ${admin.allowedDomain}` : ''}`
      + `${admin.allowedEmails.length || admin.allowedDomain ? '' : ' — nobody can sign in until config/n8n.json lists somebody'}\n`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
      process.stderr.write('  ! bound to a public interface. Put nginx or the tunnel in front of this.\n');
    }
    process.stdout.write('\n');
  });
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(ROOT, 'src', 'admin.js')) main();
