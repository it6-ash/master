import test from 'node:test';
import assert from 'node:assert/strict';

import { alertsFor, applyCooldown, digestDue, digestHtml, alertHtml } from '../src/n8n/report.js';
import { overview } from '../src/n8n/analytics.js';

const NOW = new Date('2026-10-04T04:30:00.000Z'); // 10:00 in Asia/Kolkata
const ALERTS = { failure: true, stale: true, anomaly: true, zeroData: true, minAnomalyPct: 40, cooldownMin: 360 };

const wf = (over = {}) => ({
  id: 'aaaaaaaaaaaa', key: 'main__aaaaaaaaaaaa', instance: 'main', name: 'CRM Sync',
  expectedIntervalMin: 60, staleAfterMin: 135, minimumItems: 1, consecutiveFailures: 3, ...over,
});

const analysed = (over = {}) => ({
  workflow: wf(over.workflow),
  range: { label: '24 hours' },
  stats: {
    executions: 20, successful: 20, failed: 0, failureRate: 0, items: 2000,
    itemsCovered: 20, itemsComplete: true, avgMs: 1200, maxMs: 3000, rows: [],
    ...over.stats,
  },
  baseline: { ok: true, days: 14, items: { median: 2000, mad: 100 } },
  anomalies: over.anomalies ?? [],
  health: { state: 'HEALTHY', reasons: [], sinceMin: 10, consecutiveFailures: 0, ...over.health },
  store: { rows: over.rows ?? [], buckets: {}, sync: {} },
});

/* -------------------------------------------------------------- alerts */

test('a consecutive-failure streak raises one CRITICAL that names the node', () => {
  const got = alertsFor(analysed({
    health: { state: 'CRITICAL', consecutiveFailures: 5, reasons: [] },
    rows: [{ id: '99', status: 'error', failedNode: 'CRM Insert', error: 'HTTP 500 from the CRM' }],
  }), { alerts: ALERTS });

  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'failure');
  assert.equal(got[0].severity, 'critical');
  assert.match(got[0].subject, /^CRITICAL: CRM Sync has failed 5 times in a row$/);
  assert.match(got[0].detail, /"CRM Insert" node/);
  assert.match(got[0].detail, /HTTP 500 from the CRM/);
  assert.equal(got[0].key, 'main__aaaaaaaaaaaa:failure');
});

test('a stale workflow raises its own alert, with how long it has been quiet', () => {
  const got = alertsFor(analysed({ health: { state: 'STALE', sinceMin: 220, reasons: [] } }), { alerts: ALERTS });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'stale');
  assert.match(got[0].subject, /has not executed for 4h/);
  assert.match(got[0].detail, /Expected every 1h/);
});

test('zero-data succeeds-but-produces-nothing gets said in those words', () => {
  const got = alertsFor(analysed({
    health: { state: 'NO DATA', reasons: [{ state: 'NO DATA', why: 'the last 3 successful runs produced no items at all' }] },
  }), { alerts: ALERTS });
  assert.equal(got[0].kind, 'zero-data');
  assert.match(got[0].subject, /succeeded but produced 0 items/);
  assert.match(got[0].detail, /produced no items at all/);
});

test('an anomaly below the configured percentage is not mailed at all', () => {
  const quiet = alertsFor(analysed({
    anomalies: [{ kind: 'volume-drop', pct: 25, detail: '25% below normal', severity: 'high', observed: 10, expected: 13 }],
  }), { alerts: ALERTS });
  assert.deepEqual(quiet, [], '25% is under minAnomalyPct 40');

  const loud = alertsFor(analysed({
    anomalies: [{ kind: 'volume-drop', pct: 72, detail: '72% below its normal 2,000 items', severity: 'high', observed: 560, expected: 2000 }],
  }), { alerts: ALERTS });
  assert.equal(loud.length, 1);
  assert.match(loud[0].subject, /data volume dropped 72%/);
});

test('each alert kind can be switched off independently', () => {
  const a = analysed({
    health: { state: 'CRITICAL', consecutiveFailures: 5, sinceMin: 400, reasons: [] },
    anomalies: [{ kind: 'volume-drop', pct: 72, detail: 'x', severity: 'high' }],
  });
  assert.equal(alertsFor(a, { alerts: { ...ALERTS, failure: false } }).some((x) => x.kind === 'failure'), false);
  assert.equal(alertsFor(a, { alerts: { ...ALERTS, anomaly: false } }).some((x) => x.kind.startsWith('anomaly')), false);
  assert.equal(alertsFor(a, { alerts: { failure: false, stale: false, anomaly: false, zeroData: false } }).length, 0);
});

test('a healthy workflow raises nothing', () => {
  assert.deepEqual(alertsFor(analysed(), { alerts: ALERTS }), []);
});

/* ------------------------------------------------------------ cooldown */

test('the same alert inside the cooldown is held, and counts up while it waits', () => {
  const raised = alertsFor(analysed({
    health: { state: 'CRITICAL', consecutiveFailures: 5, reasons: [] },
    rows: [{ id: '1', status: 'error' }],
  }), { alerts: ALERTS });

  const first = applyCooldown(raised, { sent: {} }, { cooldownMin: 360, now: NOW });
  assert.equal(first.due.length, 1);
  assert.equal(first.due[0].count, 1);

  // An hour later, still broken. Six hours is the cooldown.
  const hourLater = new Date(NOW.getTime() + 3600000);
  const second = applyCooldown(raised, { sent: first.sent }, { cooldownMin: 360, now: hourLater });
  assert.equal(second.due.length, 0, 'one broken workflow must not mail on every pass');
  assert.equal(second.held[0].count, 2);

  // Seven hours later it goes again, and can say it is not the first time.
  const muchLater = new Date(NOW.getTime() + 7 * 3600000);
  const third = applyCooldown(raised, { sent: second.sent }, { cooldownMin: 360, now: muchLater });
  assert.equal(third.due.length, 1);
  assert.equal(third.due[0].count, 3, '"3rd report" is how you tell a new break from an old one');
});

test('an alert that has cleared is forgotten, so the next one is fresh', () => {
  const raised = alertsFor(analysed({
    health: { state: 'CRITICAL', consecutiveFailures: 5, reasons: [] }, rows: [{ id: '1', status: 'error' }],
  }), { alerts: ALERTS });
  const first = applyCooldown(raised, { sent: {} }, { cooldownMin: 360, now: NOW });

  // Fixed. Nothing raised this pass.
  const cleared = applyCooldown([], { sent: first.sent }, { cooldownMin: 360, now: new Date(NOW.getTime() + 60000) });
  assert.deepEqual(cleared.sent, {}, 'a resolved problem must not leave a cooldown behind');

  // Breaks again straight away: that is news, and goes out immediately.
  const again = applyCooldown(raised, { sent: cleared.sent }, { cooldownMin: 360, now: new Date(NOW.getTime() + 120000) });
  assert.equal(again.due.length, 1);
  assert.equal(again.due[0].count, 1);
});

test('cooldowns are per workflow AND per kind — two problems are two mails', () => {
  const raised = alertsFor(analysed({
    health: { state: 'CRITICAL', consecutiveFailures: 5, sinceMin: 400, reasons: [] },
    rows: [{ id: '1', status: 'error' }],
  }), { alerts: ALERTS });
  assert.equal(raised.length, 2, 'failing AND stale');
  const { due } = applyCooldown(raised, { sent: {} }, { cooldownMin: 360, now: NOW });
  assert.deepEqual(due.map((d) => d.kind).sort(), ['failure', 'stale']);
});

/* -------------------------------------------------------------- digest */

const REPORT = { frequency: 'daily', reportAt: '09:40', timezone: 'Asia/Kolkata', weeklyOn: 'Mon' };

test('the digest hour is read in the configured zone, not the server clock', () => {
  // This box runs Etc/UTC. A bare "09:40" there mails at 15:10 in Delhi, and
  // the only symptom is a report that always arrives after lunch.
  const early = new Date('2026-10-04T03:00:00Z'); // 08:30 IST
  assert.equal(digestDue(REPORT, {}, { now: early }).yes, false);
  assert.match(digestDue(REPORT, {}, { now: early }).why, /holding until 09:40 Asia\/Kolkata/);

  assert.equal(digestDue(REPORT, {}, { now: NOW }).yes, true, '10:00 IST is past 09:40');
});

test('one digest a day, not one per collection pass', () => {
  const held = digestDue(REPORT, { lastReportedOn: '2026-10-04' }, { now: NOW });
  assert.equal(held.yes, false);
  assert.match(held.why, /already sent today/);
});

test('a weekly digest only goes on its day', () => {
  const weekly = { ...REPORT, frequency: 'weekly', weeklyOn: 'Mon' };
  // 4 Oct 2026 is a Sunday.
  assert.equal(digestDue(weekly, {}, { now: NOW }).yes, false);
  const monday = new Date('2026-10-05T04:30:00Z');
  const due = digestDue(weekly, {}, { now: monday });
  assert.equal(due.yes, true);
  assert.equal(due.kind, 'weekly');
});

/* ---------------------------------------------------------------- HTML */

test('the digest says what happened, and admits where it cannot count items', () => {
  const list = [
    analysed({ workflow: { name: 'Lead Qualification', project: 'yamini' }, stats: { executions: 820, items: 72400, failed: 4 } }),
    analysed({
      workflow: { name: 'CRM Sync' },
      stats: { executions: 210, items: 0, itemsCovered: 0, failed: 12, failureRate: 5.7 },
      health: { state: 'WARNING', reasons: [], sinceMin: 30, consecutiveFailures: 1 },
      anomalies: [{ kind: 'volume-drop', pct: 63, detail: '63% below its normal 2,000 items', severity: 'high', observed: 740, expected: 2000 }],
      rows: [{ id: '7', status: 'error', startedAt: '2026-10-04T03:12:00Z', failedNode: 'Cratio POST', error: 'HTTP 500' }],
    }),
  ];
  const html = digestHtml(list, overview(list), {
    range: { label: '24 hours' }, tz: 'Asia/Kolkata', at: '2026-10-04 04:30',
    sync: { lastRunAt: '2026-10-04T04:07:00Z', synced: 2, workflows: 2, failed: 0 },
    kind: 'daily',
  });

  assert.match(html, /1,030/, 'executions summed');
  assert.match(html, /72,400/, 'items summed');
  assert.match(html, /1 needs attention/);
  assert.match(html, /63% below its normal/);
  assert.match(html, /Cratio POST/);
  assert.match(html, /HTTP 500/);
  assert.match(html, />n\/a</, 'a workflow with no item counts says n/a, never 0');
  assert.match(html, /no count is estimated/);
  // Email clients strip a <style> block and Outlook has no grid, so the layout
  // has to be tables and inline styles or it arrives as unstyled text.
  assert.doesNotMatch(html, /<style/);
  assert.match(html, /max-width:680px/);
});

test('the digest leads with a warning when the collector itself is not running', () => {
  const list = [analysed()];
  const html = digestHtml(list, overview(list), {
    range: { label: '24 hours' }, tz: 'UTC', at: 'now', sync: null, kind: 'daily',
  });
  assert.match(html, /collector has never completed a pass/,
    'every figure below is stale, and the mail must say so before it quotes them');
});

test('a healthy day says so without a table of alarms', () => {
  const list = [analysed()];
  const html = digestHtml(list, overview(list), {
    range: { label: '24 hours' }, tz: 'UTC', at: 'now',
    sync: { lastRunAt: '2026-10-04T04:07:00Z', synced: 1, workflows: 1, failed: 0 }, kind: 'daily',
  });
  assert.match(html, /Everything healthy/);
  assert.doesNotMatch(html, /outside its normal range/);
});

test('an alert mail is one sentence, a link, and the cooldown it is under', () => {
  const alert = {
    kind: 'failure',
    severity: 'critical',
    subject: 'CRITICAL: CRM Sync has failed 5 times in a row',
    detail: '5 consecutive failures, latest at the "CRM Insert" node.',
    workflow: wf({ project: 'yamini' }),
    count: 3,
    cooldownMin: 360,
  };
  const html = alertHtml(alert, { at: '2026-10-04 04:30' });
  assert.match(html, /CRITICAL: CRM Sync has failed 5 times in a row/);
  assert.match(html, /report 3 for this/);
  assert.match(html, /#workflow=aaaaaaaaaaaa/, 'it must link straight to the page that explains it');
  assert.match(html, /held for\s*\n?\s*360 minutes/);
});

test('every include toggle actually drops its section', () => {
  // Config that advertises a switch which does nothing is worse than no
  // switch: somebody turns it off, the section keeps arriving, and they stop
  // believing the rest of the file too.
  const list = [analysed({
    stats: { failed: 2, executions: 10, points: [{ key: '2026-10-04T09', n: 10, items: 500 }] },
    anomalies: [{ kind: 'volume-drop', pct: 63, detail: '63% below normal', severity: 'high', observed: 500, expected: 1350 }],
    rows: [{ id: '1', status: 'error', startedAt: '2026-10-04T09:00:00Z', failedNode: 'CRM Insert', error: 'HTTP 500' }],
  })];
  const base = {
    range: { label: '24 hours' }, tz: 'UTC', at: 'now', kind: 'daily',
    sync: { lastRunAt: '2026-10-04T04:07:00Z', synced: 1, workflows: 1, failed: 0 },
  };
  const totals = overview(list);
  const html = (include) => digestHtml(list, totals, { ...base, include });

  const all = html({});
  // `Executions</th>` rather than `Workflow</th>`: the failures table has a
  // Workflow header too, so that would pass whether or not the summary
  // table survived.
  assert.match(all, /Executions<\/th>/, 'the per-workflow table');
  assert.match(all, /Executions per hour/, 'the chart');
  assert.match(all, /outside its normal range/, 'the anomalies');
  assert.match(all, /<h3[^>]*>Failures/, 'the failures');

  assert.doesNotMatch(html({ summaries: false }), /Executions<\/th>/);
  assert.doesNotMatch(html({ charts: false }), /Executions per hour/);
  assert.doesNotMatch(html({ anomalies: false }), /outside its normal range/);
  assert.doesNotMatch(html({ failures: false }), /<h3[^>]*>Failures/);
});

test('a missing include key means yes, not no', () => {
  // Opt-out, not opt-in. Somebody adding an `include` block and forgetting a
  // key must not silently lose their failures table.
  const list = [analysed({ stats: { failed: 1, executions: 3, points: [{ key: '2026-10-04T09', n: 3, items: 9 }] },
    rows: [{ id: '1', status: 'error', startedAt: '2026-10-04T09:00:00Z', failedNode: 'N', error: 'x' }] })];
  const html = digestHtml(list, overview(list), {
    range: { label: '24h' }, tz: 'UTC', at: 'now', kind: 'daily',
    sync: { lastRunAt: 'x', synced: 1, workflows: 1, failed: 0 },
    include: { charts: false },
  });
  assert.match(html, /<h3[^>]*>Failures/, 'failures survives an include block that only mentions charts');
  assert.match(html, /Executions<\/th>/, 'and so does the summary table');
});

test('the email chart is table cells, because every other kind is stripped', () => {
  // Gmail strips inline SVG and blocks data: image URIs; both arrive as a
  // blank gap. Table cells with a background colour render everywhere,
  // including Outlook's Word engine, and load nothing.
  const list = [analysed({ stats: { points: [
    { key: '2026-10-04T08', n: 4, items: 400 },
    { key: '2026-10-04T09', n: 8, items: 900 },
  ] } })];
  const html = digestHtml(list, overview(list), {
    range: { label: '24h' }, tz: 'UTC', at: 'now', kind: 'daily',
    sync: { lastRunAt: 'x', synced: 1, workflows: 1, failed: 0 },
  });
  assert.doesNotMatch(html, /<svg/, 'Gmail strips it');
  assert.doesNotMatch(html, /<img/, 'nothing to load, nothing to fail');
  assert.match(html, /background:#0d9c8a/, 'the bars are coloured cells');
  assert.match(html, /peak 8/, 'and the figures are stated, not only drawn');
});

test('HTML is escaped, because an n8n error message is remote text', () => {
  const list = [analysed({
    workflow: { name: '<script>alert(1)</script>' },
    stats: { failed: 1, executions: 1, items: 0, itemsCovered: 0 },
    rows: [{ id: '1', status: 'error', startedAt: '2026-10-04T03:00:00Z', failedNode: 'A', error: '<img src=x onerror=1>' }],
  })];
  const html = digestHtml(list, overview(list), {
    range: { label: '24 hours' }, tz: 'UTC', at: 'now', sync: { lastRunAt: 'x', synced: 1, workflows: 1, failed: 0 }, kind: 'daily',
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});
