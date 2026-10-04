#!/usr/bin/env node
/**
 * npm run wf-report — mail the workflow analytics digest, and alert on
 * anything that broke since the last pass.
 *
 *   npm run wf-report                  decide, then send what is due
 *   npm run wf-report -- --force       send the digest now regardless of time
 *   npm run wf-report -- --dry-run     print the decision and the HTML, send nothing
 *   npm run wf-report -- --alerts-only skip the digest, send only event alerts
 *
 * Two different things go out of here, for two different reasons:
 *
 *   the DIGEST   one a day at reportAt, or one a week. A summary nobody has to
 *                ask for. Scheduled, so it is never urgent.
 *   an ALERT     the moment something breaks. Not scheduled, and cooled down
 *                per workflow per kind so one broken workflow cannot mail
 *                twenty times before anybody fixes it. The twenty-first mail
 *                is the one nobody reads, and one of those is always real.
 *
 * It reuses the mailer the outside-in check already posts to — same webhook,
 * same recipients, same loopback fallback for when the public route to n8n is
 * the thing that is broken. One mailer to keep working, not two.
 */

import path from 'node:path';

import { ROOT, abs, readJson, writeJsonIfChanged } from '../lib/fsx.js';
import { isoDate } from '../lib/units.js';
import { loopbackFor, localTime } from '../check.js';
import { resolveRegistry } from './registry.js';
import { loadStore, bucketKey } from './collect.js';
import { analyse, overview, formatMins } from './analytics.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force') || args.includes('--force-report');
const alertsOnly = args.includes('--alerts-only');

const TIMEOUT_MS = 20000;
const STATE_FILE = ['data', 'n8n-alerts.json'];

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (color ? `[${c}m${s}[0m` : s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const dim = (s) => paint('2', s);

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dur = (v) => (Number.isFinite(v) ? (v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`) : '—');

/* -------------------------------------------------------------- alerts */

/**
 * Every alert this pass would raise, before cooldowns are applied.
 *
 * Deliberately derived from the same `health` and `anomalies` rules the
 * dashboard uses, not from a second set written for email — a mail that
 * disagrees with the page is worse than no mail, because now you have to work
 * out which one is lying.
 */
export function alertsFor(a, { alerts }) {
  const out = [];
  const w = a.workflow;
  const name = w.name ?? w.id;

  if (alerts.failure !== false && a.health.consecutiveFailures >= (w.consecutiveFailures ?? 3)) {
    out.push({
      kind: 'failure',
      severity: 'critical',
      subject: `CRITICAL: ${name} has failed ${a.health.consecutiveFailures} times in a row`,
      detail: `${a.health.consecutiveFailures} consecutive failures`
        + `${a.store.rows?.[0]?.failedNode ? `, latest at the "${a.store.rows[0].failedNode}" node` : ''}.`
        + `${a.store.rows?.[0]?.error ? ` ${a.store.rows[0].error}` : ''}`,
    });
  }

  if (alerts.stale !== false && (a.health.state === 'STALE' || (a.health.state === 'CRITICAL' && w.staleAfterMin
    && a.health.sinceMin > w.staleAfterMin))) {
    out.push({
      kind: 'stale',
      severity: a.health.state === 'CRITICAL' ? 'critical' : 'warning',
      subject: `WARNING: ${name} has not executed for ${formatMins(a.health.sinceMin)}`,
      detail: `Expected every ${formatMins(w.expectedIntervalMin)}; last run was ${formatMins(a.health.sinceMin)} ago.`,
    });
  }

  if (alerts.anomaly !== false) {
    for (const an of a.anomalies) {
      if (an.pct < (alerts.minAnomalyPct ?? 40)) continue;
      out.push({
        kind: `anomaly-${an.kind}`,
        severity: an.severity === 'high' ? 'critical' : 'warning',
        subject: `WARNING: ${name} ${an.kind === 'volume-drop' ? `data volume dropped ${an.pct}%` : an.detail}`,
        detail: `${an.detail}. Observed ${fmt(an.observed)} against a normal ${fmt(an.expected)}.`,
      });
    }
  }

  if (alerts.zeroData !== false && a.health.state === 'NO DATA') {
    out.push({
      kind: 'zero-data',
      severity: 'warning',
      subject: `WARNING: ${name} succeeded but produced 0 items`,
      detail: a.health.reasons.find((r) => r.state === 'NO DATA')?.why
        ?? 'recent successful runs produced no items',
    });
  }

  return out.map((alert) => ({ ...alert, workflow: w, key: `${w.key}:${alert.kind}` }));
}

/**
 * Hold anything already said inside the cooldown.
 *
 * A held alert still bumps its counter, so when it does go out it can say
 * "4th report" — which is the difference between "this just broke" and "this
 * has been broken all day and nobody has looked".
 */
export function applyCooldown(raised, state, { cooldownMin = 360, now }) {
  const sent = { ...(state.sent ?? {}) };
  const due = [];
  const held = [];

  for (const alert of raised) {
    const previous = sent[alert.key];
    const sinceMin = previous?.at ? (new Date(now).getTime() - Date.parse(previous.at)) / 60000 : Infinity;
    const count = (previous?.count ?? 0) + 1;

    if (sinceMin < cooldownMin) {
      sent[alert.key] = { ...previous, count, detail: alert.detail };
      held.push({ ...alert, sinceMin: Math.round(sinceMin), count });
      continue;
    }
    sent[alert.key] = { at: new Date(now).toISOString(), count, detail: alert.detail };
    due.push({ ...alert, count });
  }

  // An alert nobody raised this pass has cleared. Drop it, so the next
  // occurrence is a fresh "this just broke" rather than a cooled-down one.
  const live = new Set(raised.map((a) => a.key));
  for (const key of Object.keys(sent)) if (!live.has(key)) delete sent[key];

  return { due, held, sent };
}

/* -------------------------------------------------------------- digest */

/**
 * Is a digest due?
 *
 * Once a day at reportAt, in the configured zone rather than the server's —
 * srv1340120 runs Etc/UTC and a bare "09:40" there mails at 15:10 in Delhi,
 * which nobody notices for weeks except that the report keeps arriving after
 * lunch. The collector runs four times a day; four identical "all healthy"
 * mails is how a report becomes a filter rule.
 */
export function digestDue(report, state, { now }) {
  const tz = report.timezone ?? 'Asia/Kolkata';
  const at = report.reportAt ?? '09:40';
  const today = isoDate(new Date(now));
  if (state.lastReportedOn === today) return { yes: false, why: 'already sent today' };
  if (localTime(new Date(now), tz) < at) return { yes: false, why: `holding until ${at} ${tz}` };

  if ((report.frequency ?? 'daily') === 'weekly') {
    const want = report.weeklyOn ?? 'Mon';
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(new Date(now));
    if (day !== want) return { yes: false, why: `weekly report, ${want} only (today is ${day})` };
    return { yes: true, kind: 'weekly', why: `weekly report, ${want} ${at} ${tz}` };
  }
  return { yes: true, kind: 'daily', why: `daily report, ${at} ${tz}` };
}

/* ---------------------------------------------------------------- HTML */

const TD = 'padding:7px 10px;border-bottom:1px solid #eee;font-size:13px';
const TH = 'padding:7px 10px;border-bottom:2px solid #333;text-align:left;font-size:12px;color:#555';

/**
 * A chart that survives an email client.
 *
 * Not SVG and not an <img>: Gmail strips inline SVG outright, and blocks
 * `data:` image URIs, so both arrive as a blank gap. Hosting a PNG somewhere
 * would mean this mail stops rendering the moment that host has a bad day —
 * for a chart.
 *
 * Table cells with a background colour and a pixel height render everywhere,
 * including Outlook's Word engine, and need nothing loaded. One column per
 * hour, tallest bar 56px, and the figures are in the row underneath so the
 * chart is never the only route to a number.
 */
function barChart(points, { value, label, color = '#0d9c8a' }) {
  const live = points.slice(-24);
  const max = Math.max(1, ...live.map(value));
  const cells = live.map((p) => {
    const v = value(p);
    const h = Math.max(v > 0 ? 2 : 1, Math.round((v / max) * 56));
    return `<td style="vertical-align:bottom;padding:0 1px">
      <div style="height:${56 - h}px;line-height:${56 - h}px;font-size:1px">&nbsp;</div>
      <div style="height:${h}px;background:${v > 0 ? color : '#e6e6e6'};font-size:1px;line-height:${h}px">&nbsp;</div>
    </td>`;
  }).join('');

  const hour = (p) => (p.key.length > 10 ? p.key.slice(11, 13) : p.key.slice(8, 10));
  const ticks = live.map((p, i) => `<td style="font:9px/1.4 monospace;color:#aaa;text-align:center;padding:2px 0">${
    i === 0 || i === live.length - 1 || i === Math.floor(live.length / 2) ? esc(hour(p)) : ''
  }</td>`).join('');

  return `<p style="margin:18px 0 4px;font-size:12px;color:#555"><b>${esc(label)}</b>
    <span style="color:#aaa">· peak ${fmt(max)} · last ${live.length} hours</span></p>
  <table style="border-collapse:collapse;width:100%;max-width:660px"><tr>${cells}</tr><tr>${ticks}</tr></table>`;
}

/**
 * Table layout and inline styles throughout, because that is what email
 * clients render. Outlook has no grid and Gmail strips a <style> block, so a
 * stylesheet here would arrive as unstyled text — on the one screen where this
 * has to be readable at a glance.
 *
 * Capped at 680px and single-column, which reads on a phone without a
 * media query.
 */
export function digestHtml(analysed, totals, { range, tz, at, sync, kind, include = {} }) {
  // Each section is opt-OUT: a key absent from the config means "yes". A
  // report that silently drops its failures table because somebody added an
  // `include` block and forgot a key is worse than one that ignores the block.
  const want = (key) => include[key] !== false;

  const attention = analysed.filter((a) => !['HEALTHY', 'UNKNOWN'].includes(a.health.state));
  const anomalous = want('anomalies') ? analysed.filter((a) => a.anomalies.length) : [];
  const failing = want('failures') ? analysed.filter((a) => a.stats.failed > 0) : [];

  const rows = !want('summaries') ? '' : [...analysed]
    .sort((a, b) => b.stats.items - a.stats.items || b.stats.executions - a.stats.executions)
    .map((a) => `<tr>
      <td style="${TD}"><b>${esc(a.workflow.name ?? a.workflow.id)}</b>${a.workflow.project
  ? `<br><span style="color:#999;font-size:11px">${esc(a.workflow.project)}</span>` : ''}</td>
      <td style="${TD};text-align:right">${fmt(a.stats.executions)}</td>
      <td style="${TD};text-align:right">${a.stats.itemsCovered ? fmt(a.stats.items) : '<span style="color:#aaa">n/a</span>'}</td>
      <td style="${TD};text-align:right${a.stats.failed ? ';color:#c0392b;font-weight:600' : ''}">${fmt(a.stats.failed)}</td>
      <td style="${TD};color:${a.health.state === 'HEALTHY' ? '#0d9c8a' : (a.health.state === 'CRITICAL' ? '#c0392b' : '#b8860b')}">${esc(a.health.state)}</td>
    </tr>`).join('');

  /* Summed across every reported workflow, so the shape is the estate's.
     Two charts, because executions and items answer different questions and a
     dual axis would be a lie about both. */
  const points = [];
  for (const a of analysed) {
    (a.stats.points ?? []).forEach((p, i) => {
      points[i] ??= { key: p.key, n: 0, items: 0 };
      points[i].n += p.n;
      points[i].items += p.items;
    });
  }
  const chartSection = want('charts') && points.some((p) => p.n > 0)
    ? barChart(points, { value: (p) => p.n, label: 'Executions per hour' })
      + barChart(points, { value: (p) => p.items, label: 'Items processed per hour', color: '#b8860b' })
    : '';

  const anomalySection = anomalous.length ? `
    <h3 style="margin:26px 0 6px;font-size:15px">${anomalous.length} workflow${anomalous.length === 1 ? '' : 's'} outside its normal range</h3>
    ${anomalous.map((a) => `<p style="margin:0 0 10px;font-size:13px">
      <b>${esc(a.workflow.name ?? a.workflow.id)}</b><br>
      ${a.anomalies.map((an) => `${esc(an.detail)} <span style="color:#999">(${fmt(an.observed)} today against a normal ${fmt(an.expected)})</span>`).join('<br>')}
    </p>`).join('')}` : '';

  const failureSection = failing.length ? `
    <h3 style="margin:26px 0 6px;font-size:15px">Failures</h3>
    <table style="border-collapse:collapse;width:100%">
      <thead><tr><th style="${TH}">Workflow</th><th style="${TH}">Node</th><th style="${TH}">Error</th></tr></thead>
      <tbody>${failing.flatMap((a) => (a.store.rows ?? [])
    .filter((r) => r.status === 'error').slice(0, 3)
    .map((r) => `<tr>
        <td style="${TD}">${esc(a.workflow.name ?? a.workflow.id)}<br><span style="color:#999;font-size:11px">${esc(String(r.startedAt ?? '').replace('T', ' ').slice(0, 16))}</span></td>
        <td style="${TD}">${esc(r.failedNode ?? '—')}</td>
        <td style="${TD};color:#c0392b">${esc(String(r.error ?? '').slice(0, 120))}</td>
      </tr>`)).join('')}</tbody>
    </table>` : '';

  const syncLine = sync?.lastRunAt
    ? `Collected ${esc(sync.lastRunAt.replace('T', ' ').slice(0, 16))} UTC · ${sync.synced}/${sync.workflows} workflows synced`
      + `${sync.failed ? `, <b style="color:#c0392b">${sync.failed} failed to sync</b>` : ''}`
    : '<b style="color:#c0392b">The collector has never completed a pass — these figures are not current.</b>';

  return `<div style="font:14px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:#222;max-width:680px">
  <h2 style="margin:0 0 4px">KW Estate — n8n workflow ${esc(kind === 'weekly' ? 'week' : 'day')}</h2>
  <p style="margin:0 0 18px;color:#888;font-size:13px">${esc(at)} · last ${esc(range.label)} · ${esc(tz)}<br>${syncLine}</p>

  <table style="border-collapse:collapse;margin:0 0 18px">
    <tr>
      <td style="padding:0 22px 0 0"><div style="font-size:26px;font-weight:600">${fmt(totals.executions)}</div><div style="color:#888;font-size:12px">executions</div></td>
      <td style="padding:0 22px 0 0"><div style="font-size:26px;font-weight:600;color:${totals.failed ? '#c0392b' : '#222'}">${fmt(totals.failed)}</div><div style="color:#888;font-size:12px">failed${totals.failureRate === null ? '' : ` · ${totals.failureRate.toFixed(1)}%`}</div></td>
      <td style="padding:0 22px 0 0"><div style="font-size:26px;font-weight:600">${fmt(totals.items)}</div><div style="color:#888;font-size:12px">items processed</div></td>
      <td style="padding:0"><div style="font-size:26px;font-weight:600">${esc(dur(totals.avgMs))}</div><div style="color:#888;font-size:12px">average runtime</div></td>
    </tr>
  </table>

  <p style="margin:0 0 18px;font-size:14px">
    ${totals.workflows} workflow${totals.workflows === 1 ? '' : 's'} monitored.
    ${attention.length
    ? `<b style="color:#c0392b">${attention.length} need${attention.length === 1 ? 's' : ''} attention</b>
       (${esc(attention.map((a) => a.health.state).join(', '))}).`
    : 'Everything healthy.'}
  </p>

  ${rows ? `<table style="border-collapse:collapse;width:100%">
    <thead><tr>
      <th style="${TH}">Workflow</th>
      <th style="${TH};text-align:right">Executions</th>
      <th style="${TH};text-align:right">Items</th>
      <th style="${TH};text-align:right">Failures</th>
      <th style="${TH}">Health</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>` : ''}
  ${chartSection}
  ${anomalySection}
  ${failureSection}

  <p style="margin-top:26px;font-size:12px;color:#aaa">
    Item counts come from n8n's node run data and are the largest number of items any one node emitted per execution.
    "n/a" means n8n withheld or had already pruned that execution's data — no count is estimated.
    Full detail at <a href="https://estate.leadq.co.in#analytics" style="color:#0d9c8a">estate.leadq.co.in</a>.
  </p>
</div>`;
}

export function alertHtml(alert, { at }) {
  const a = alert;
  return `<div style="font:14px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:#222;max-width:680px">
  <h2 style="margin:0 0 4px;color:${a.severity === 'critical' ? '#c0392b' : '#b8860b'}">${esc(a.subject)}</h2>
  <p style="margin:0 0 18px;color:#888;font-size:13px">${esc(at)}${a.count > 1 ? ` · report ${a.count} for this` : ''}</p>
  <p style="margin:0 0 16px;font-size:15px">${esc(a.detail)}</p>
  <table style="border-collapse:collapse;font-size:13px">
    <tr><td style="${TD};color:#888">Workflow</td><td style="${TD}"><b>${esc(a.workflow.name ?? a.workflow.id)}</b></td></tr>
    <tr><td style="${TD};color:#888">Id</td><td style="${TD}">${esc(a.workflow.id)}</td></tr>
    <tr><td style="${TD};color:#888">Instance</td><td style="${TD}">${esc(a.workflow.instance)}</td></tr>
    ${a.workflow.project ? `<tr><td style="${TD};color:#888">Project</td><td style="${TD}">${esc(a.workflow.project)}</td></tr>` : ''}
  </table>
  <p style="margin-top:22px;font-size:13px">
    <a href="https://estate.leadq.co.in#workflow=${esc(a.workflow.id)}" style="color:#0d9c8a">Open its execution history, data volume and failures</a>
    on the dashboard.
  </p>
  <p style="margin-top:18px;font-size:12px;color:#aaa">
    Further reports for this workflow and this problem are held for
    ${esc(String(a.cooldownMin ?? 360))} minutes, so a broken workflow cannot fill your inbox.
  </p>
</div>`;
}

/* ---------------------------------------------------------------- send */

/**
 * The same POST shape check.js uses, plus a pre-rendered `html`.
 *
 * The Format report node in deploy/n8n-kw-estate.json passes `html` through
 * when it is present and builds its own when it is not, so the two senders
 * share one webhook, one credential and one Gmail node.
 */
async function post(webhook, payload, { servers }) {
  if (dryRun) return { sent: false, reason: 'dry run' };
  if (!webhook) return { sent: false, reason: 'no webhook configured under report.webhook' };

  const attempt = async (url, via) => {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { sent: res.status < 400, status: res.status, reply: (await res.text()).slice(0, 160), via };
  };

  try {
    return await attempt(webhook, 'configured URL');
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.message);
    // A broken certificate on n8n's hostname must not be able to silence the
    // alert that would have reported it. This has happened here before.
    const direct = loopbackFor(webhook, servers);
    if (!direct) return { sent: false, reason: why };
    try {
      return await attempt(direct, `loopback after ${why}`);
    } catch (e2) {
      return { sent: false, reason: `${why}; loopback also failed: ${e2.cause?.code ?? e2.message}` };
    }
  }
}

/* ----------------------------------------------------------------- run */

export async function runReport({ now = new Date() } = {}) {
  const registry = resolveRegistry();
  const report = registry.report ?? {};
  const alerts = report.alerts ?? {};
  const tz = report.timezone ?? 'Asia/Kolkata';
  const recipients = [report.notify ?? []].flat().filter(Boolean);

  const reportable = registry.workflows.filter((w) => w.monitoring && w.reporting !== false);
  if (!reportable.length) {
    process.stdout.write(`${dim('No workflows are registered for reporting.')}\n`);
    return 0;
  }
  if (!recipients.length) {
    process.stdout.write(`${red('✗')} no recipients. Add addresses under report.notify in config/n8n.example.json.\n`);
    return 2;
  }

  const analysed = reportable.map((w) => {
    const a = analyse(w, loadStore(w), { now, range: '24h', tz, bucketKey });
    return a;
  });
  const totals = overview(analysed);
  const serversFile = readJson(abs('data', 'servers.json'));
  const servers = serversFile.ok ? serversFile.value : {};

  const stateFile = readJson(abs(...STATE_FILE));
  const state = stateFile.ok ? stateFile.value : { lastReportedOn: null, lastReportKind: null, sent: {} };

  const at = new Date(now).toISOString().replace('T', ' ').slice(0, 16);
  const envelope = (subject, html) => ({
    subject,
    to: recipients.join(', '),
    toList: recipients,
    cc: [report.cc ?? []].flat().filter(Boolean).join(', ') || undefined,
    at,
    html,
    healthy: totals.failed === 0 && totals.byHealth.HEALTHY === totals.workflows,
    summary: {
      workflows: totals.workflows,
      executions: totals.executions,
      successful: totals.successful,
      failed: totals.failed,
      items: totals.items,
    },
  });

  let sentAnything = false;

  /* -------- event alerts first. Something that broke an hour ago must not
     wait for tomorrow's digest. */
  const raised = analysed.flatMap((a) => alertsFor(a, { alerts }));
  const { due, held, sent } = applyCooldown(raised, state, {
    cooldownMin: alerts.cooldownMin ?? 360, now,
  });

  for (const h of held) {
    process.stdout.write(`${dim(`· held: ${h.subject} (last sent ${formatMins(h.sinceMin)} ago, ${h.count} occurrences)`)}\n`);
  }

  let alertsSent = 0;
  for (const alert of due) {
    const payload = envelope(`KW Estate: ${alert.subject}`,
      alertHtml({ ...alert, cooldownMin: alerts.cooldownMin ?? 360 }, { at }));
    const posted = await post(report.webhook, payload, { servers });
    sentAnything = sentAnything || posted.sent;
    if (posted.sent) alertsSent += 1;
    process.stdout.write(posted.sent
      ? `${green('✓')} alert: ${alert.subject} ${dim(posted.via === 'configured URL' ? '' : `via ${posted.via}`)}\n`
      : `${red('✗')} alert not sent: ${alert.subject} — ${posted.reason ?? `HTTP ${posted.status} ${posted.reply}`}\n`);

    // A send that failed must be retried on the next pass, not swallowed by a
    // cooldown it never earned. The entry is DELETED rather than blanked:
    // writing `at: null` would both fail the schema and leave a record
    // claiming the alert had been handled.
    if (!posted.sent) {
      const earlier = state.sent?.[alert.key];
      if (earlier?.at) sent[alert.key] = earlier;
      else delete sent[alert.key];
    }
  }

  /* -------- then the digest */
  const decision = force ? { yes: true, kind: report.frequency ?? 'daily', why: '--force' }
    : (alertsOnly ? { yes: false, why: '--alerts-only' } : digestDue(report, state, { now }));

  let digestSent = false;
  if (decision.yes) {
    const subject = `KW Estate Workflow Report — ${new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, day: '2-digit', month: 'short', year: 'numeric',
    }).format(new Date(now))}`;
    const syncState = readJson(abs('data', 'n8n-sync.json'));
    const html = digestHtml(analysed, totals, {
      range: analysed[0]?.range ?? { label: '24 hours' },
      tz,
      at,
      sync: syncState.ok ? syncState.value : null,
      kind: decision.kind,
      include: report.include ?? {},
    });
    if (dryRun) process.stdout.write(`\n${html}\n\n`);
    const posted = await post(report.webhook, envelope(subject, html), { servers });
    digestSent = posted.sent;
    sentAnything = sentAnything || posted.sent;
    process.stdout.write(posted.sent
      ? `${green('✓')} digest mailed to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'} — ${decision.why}\n`
      : `${red('✗')} digest not sent — ${posted.reason ?? `HTTP ${posted.status} ${posted.reply}`}\n`);
  } else {
    process.stdout.write(`${dim(`· no digest: ${decision.why}`)}\n`);
  }

  const next = {
    // Only mark the day done when a mail actually went: a failed send must be
    // retried on the next pass, not silently skipped until tomorrow.
    lastReportedOn: digestSent ? isoDate(new Date(now)) : (state.lastReportedOn ?? null),
    lastReportKind: digestSent ? (decision.kind ?? 'daily') : (state.lastReportKind ?? null),
    sent,
  };
  if (!dryRun) writeJsonIfChanged(abs(...STATE_FILE), next);

  // "sent" means a mail actually went. Counting `due` here read "1 alert sent"
  // for an alert the webhook had just rejected, which is the one number in
  // this output that must never be optimistic.
  const failedToSend = due.length - alertsSent;
  process.stdout.write(`\n${totals.workflows} workflows · ${totals.executions} executions · ${totals.failed} failed`
    + ` · ${alertsSent} alert${alertsSent === 1 ? '' : 's'} sent`
    + `${failedToSend ? `, ${failedToSend} failed to send` : ''}, ${held.length} held`
    + `${dryRun ? dim(' · --dry-run: nothing sent or written') : ''}\n`);

  return failedToSend > 0 && !dryRun ? 1 : 0;
}

// See the note at the foot of collect.js: process.exit() out of a top-level
// await with a live undici socket aborts Node 24 on Windows after the work has
// already succeeded.
if (path.resolve(process.argv[1] ?? '') === path.resolve(ROOT, 'src', 'n8n', 'report.js')) {
  process.exitCode = await runReport();
}
