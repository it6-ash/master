import test from 'node:test';
import assert from 'node:assert/strict';

import {
  series, hourKeys, stageSeries, percentile, median, mad, windowStats, baseline,
  modifiedZ, anomalies, health, consecutiveFailures, overview, byProject,
  rangeById, analyse, formatMins,
} from '../src/n8n/analytics.js';
import { bucketKey, bucketsFrom, mergeBuckets, pruneRows, pruneBuckets, detailCandidates } from '../src/n8n/collect.js';

const NOW = new Date('2026-10-04T12:30:00.000Z');
const TZ = 'UTC';
const ctx = { tz: TZ, bucketKey };

/* --------------------------------------------------------- bucket keys */

test('bucketing happens in the reporting zone, not UTC', () => {
  // IST is +05:30. Bucketing in UTC and shifting later could never answer
  // "what happened between 2 and 3pm" exactly, because a UTC hour straddles
  // two IST hours.
  assert.equal(bucketKey('2026-10-04T09:00:00Z', 'UTC'), '2026-10-04T09');
  assert.equal(bucketKey('2026-10-04T09:00:00Z', 'Asia/Kolkata'), '2026-10-04T14');
  assert.equal(bucketKey('2026-10-04T19:00:00Z', 'Asia/Kolkata'), '2026-10-05T00',
    'past midnight in Delhi is the next day, even though UTC says otherwise');
});

test('midnight is hour 00, not hour 24', () => {
  // Some ICU builds hand back "24" for midnight under hour12:false.
  assert.equal(bucketKey('2026-10-04T00:15:00Z', 'UTC'), '2026-10-04T00');
  assert.equal(bucketKey('2026-10-04T18:30:00Z', 'Asia/Kolkata'), '2026-10-05T00');
});

test('an unparseable timestamp buckets nowhere rather than into "Invalid Date"', () => {
  assert.equal(bucketKey(undefined, 'UTC'), null);
  assert.equal(bucketKey('not a date', 'UTC'), null);
});

test('hourKeys covers the range with no gap, no repeat and no overshoot', () => {
  assert.deepEqual(
    hourKeys(new Date('2026-10-04T09:00:00Z'), new Date('2026-10-04T11:00:00Z'), 'UTC', bucketKey),
    ['2026-10-04T09', '2026-10-04T10', '2026-10-04T11'],
  );
  // The hour containing `to` is included without stepping past it. One step
  // too far emits a bucket that has not happened, and an always-empty bar at
  // the right edge of a chart reads as an outage.
  assert.deepEqual(
    hourKeys(new Date('2026-10-04T09:10:00Z'), new Date('2026-10-04T10:50:00Z'), 'UTC', bucketKey),
    ['2026-10-04T09', '2026-10-04T10'],
  );
});

/* ------------------------------------------------------------- series */

const BUCKETS = {
  '2026-10-04T09': { n: 4, ok: 4, fail: 0, items: 400, bytes: 4000, msSum: 4000, msMax: 1500, covered: 4 },
  '2026-10-04T10': { n: 6, ok: 5, fail: 1, items: 600, bytes: 6000, msSum: 7200, msMax: 2000, covered: 6 },
  '2026-10-04T12': { n: 2, ok: 2, fail: 0, items: 150, bytes: 1500, msSum: 1800, msMax: 1000, covered: 2 },
};

test('an hour with no executions is a point on the chart, not a missing one', () => {
  const points = series(BUCKETS, {
    from: new Date('2026-10-04T09:00:00Z'), to: new Date('2026-10-04T12:00:00Z'), grain: 'hour', ...ctx,
  });
  assert.deepEqual(points.map((p) => p.key),
    ['2026-10-04T09', '2026-10-04T10', '2026-10-04T11', '2026-10-04T12']);
  assert.equal(points[2].n, 0, 'omitting 11:00 would draw a continuous line straight through an outage');
});

test('daily and weekly grains fold the hours underneath them', () => {
  const daily = series(BUCKETS, {
    from: new Date('2026-10-04T00:00:00Z'), to: new Date('2026-10-04T23:00:00Z'), grain: 'day', ...ctx,
  });
  assert.equal(daily.length, 1);
  assert.equal(daily[0].n, 12);
  assert.equal(daily[0].items, 1150);
  assert.equal(daily[0].msMax, 2000, 'a maximum folds as a maximum, never as a sum');

  const weekly = series(BUCKETS, {
    from: new Date('2026-09-28T00:00:00Z'), to: new Date('2026-10-04T23:00:00Z'), grain: 'week', ...ctx,
  });
  assert.equal(weekly.length, 1, 'Sun 4 Oct belongs to the week beginning Mon 28 Sep');
  assert.equal(weekly[0].key, '2026-09-28');
});

/* --------------------------------------------------------- percentiles */

test('percentiles use nearest rank and survive tiny samples', () => {
  const sorted = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  assert.equal(percentile(sorted, 50), 550);
  assert.equal(percentile(sorted, 95), 955);
  assert.equal(percentile(sorted, 0), 100);
  assert.equal(percentile(sorted, 100), 1000);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([], 50), null);
});

test('MAD is the spread, because one catastrophic day must not hide the next', () => {
  const normal = [100, 102, 98, 101, 99];
  assert.equal(median(normal), 100);
  assert.equal(mad(normal), 1);

  // A standard deviation here is ~400 and would swallow a real collapse.
  const withOutlier = [100, 102, 98, 101, 99, 1000];
  assert.ok(mad(withOutlier) <= 2, 'the outlier barely moves the MAD');
});

/* -------------------------------------------------------- windowStats */

const store = (over = {}) => ({
  instance: 'main',
  workflowId: 'aaaaaaaaaaaa',
  tz: TZ,
  buckets: BUCKETS,
  rows: [
    { id: '5', status: 'success', startedAt: '2026-10-04T12:05:00Z', ms: 900, items: 80, volumeSource: 'node-data' },
    { id: '4', status: 'success', startedAt: '2026-10-04T12:01:00Z', ms: 900, items: 70, volumeSource: 'node-data' },
    { id: '3', status: 'error', startedAt: '2026-10-04T10:40:00Z', ms: 2000, failedNode: 'CRM Insert', error: 'timeout' },
    { id: '2', status: 'success', startedAt: '2026-10-04T10:10:00Z', ms: 1200, items: 100, volumeSource: 'node-data' },
    { id: '1', status: 'success', startedAt: '2026-10-04T09:10:00Z', ms: 1000, items: 100, volumeSource: 'node-data' },
  ],
  sync: { status: 'ok', lastSyncedAt: '2026-10-04T12:20:00Z' },
  ...over,
});

test('totals come from the buckets, which are exact past raw retention', () => {
  const s = windowStats(store(), {
    from: new Date('2026-10-04T09:00:00Z'), to: NOW, ...ctx,
  });
  assert.equal(s.executions, 12);
  assert.equal(s.failed, 1);
  assert.equal(s.items, 1150);
  assert.equal(s.avgMs, Math.round(13000 / 12));
  assert.equal(s.maxMs, 2000);
  assert.ok(Math.abs(s.failureRate - (1 / 12) * 100) < 0.001);
});

test('a percentile is refused when the rows do not account for every execution', () => {
  // Five rows against twelve bucketed executions. A median off five of twelve
  // is a claim about a subset dressed up as a claim about the window.
  const s = windowStats(store(), { from: new Date('2026-10-04T09:00:00Z'), to: NOW, ...ctx });
  assert.equal(s.runtimeFromRows, false);
  assert.equal(s.medianMs, null);
  assert.equal(s.p95Ms, null);
  assert.ok(Number.isFinite(s.avgMs), 'the mean still comes from the aggregate and is exact');
});

test('percentiles appear once the rows do cover the window', () => {
  const s = windowStats(store({
    buckets: { '2026-10-04T12': { n: 2, ok: 2, fail: 0, items: 150, bytes: 0, msSum: 1800, msMax: 900, covered: 2 } },
  }), { from: new Date('2026-10-04T12:00:00Z'), to: NOW, ...ctx });
  assert.equal(s.executions, 2);
  assert.equal(s.runtimeFromRows, true);
  assert.equal(s.medianMs, 900);
});

test('throughput and items-per-run are per COVERED execution, never per execution', () => {
  const s = windowStats(store(), { from: new Date('2026-10-04T11:30:00Z'), to: NOW, ...ctx });
  assert.equal(s.executions, 2);
  assert.equal(s.itemsCovered, 2);
  assert.equal(s.itemsComplete, true);
  assert.equal(s.itemsPerExecution, 75);
  assert.equal(s.throughput, 2.5, '150 items over 60 minutes');
});

test('itemsComplete is false when some executions reported no count', () => {
  const s = windowStats(store({
    buckets: { '2026-10-04T12': { n: 10, ok: 10, fail: 0, items: 150, bytes: 0, msSum: 0, msMax: 0, covered: 2 } },
  }), { from: new Date('2026-10-04T12:00:00Z'), to: NOW, ...ctx });
  assert.equal(s.itemsComplete, false, 'the item total is a floor, and the page must say so');
  assert.equal(s.itemsCovered, 2);
});

/* ----------------------------------------------------------- baseline */

/** `days` complete days of `perDay` items, ending yesterday. */
function historyBuckets(days, perDay, { runs = 10, msSum = 10000, from = '2026-10-03' } = {}) {
  const out = {};
  for (let d = 0; d < days; d += 1) {
    const day = new Date(`${from}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - d);
    out[`${day.toISOString().slice(0, 10)}T09`] = {
      n: runs, ok: runs, fail: 0, items: perDay, bytes: 0, msSum, msMax: 0, covered: runs,
    };
  }
  return out;
}

test('a baseline needs seven complete days, and says so when it has not got them', () => {
  const thin = baseline(historyBuckets(4, 400), { now: NOW, ...ctx });
  assert.equal(thin.ok, false);
  assert.equal(thin.days, 4);
  assert.equal(thin.minDays, 7);

  const enough = baseline(historyBuckets(14, 400), { now: NOW, ...ctx });
  assert.equal(enough.ok, true);
  assert.equal(enough.items.median, 400);
});

test('today is excluded from the baseline, since a day in progress is always short', () => {
  const buckets = { ...historyBuckets(14, 400), '2026-10-04T09': { n: 1, ok: 1, fail: 0, items: 5, bytes: 0, msSum: 100, msMax: 0, covered: 1 } };
  const base = baseline(buckets, { now: NOW, ...ctx });
  assert.equal(base.items.median, 400, "today's 5 items must not drag the normal down");
});

/* ------------------------------------------------------- anomalies */

test('the modified z-score is the published one, and handles a flat history', () => {
  assert.equal(modifiedZ(100, { median: 100, mad: 10 }), 0);
  assert.equal(modifiedZ(72, { median: 420, mad: 60 }), Number((0.6745 * (72 - 420) / 60).toFixed(2)));
  // A fortnight of exactly 500 has a MAD of zero. Dividing by it is not an
  // option, and "no spread so nothing is abnormal" would miss a collapse.
  assert.ok(modifiedZ(50, { median: 500, mad: 0 }) < -3.5);
  assert.equal(modifiedZ(500, { median: 500, mad: 0 }), 0);
  assert.equal(modifiedZ(undefined, { median: 500, mad: 10 }), null);
});

test('a volume collapse is flagged with the percentage a human can act on', () => {
  const base = baseline(historyBuckets(14, 420), { now: NOW, ...ctx });
  const got = anomalies({ items: 72, itemsCovered: 10, avgMs: null }, base, { dropPct: 40, partialDay: 1 });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'volume-drop');
  assert.equal(got[0].pct, 83, '72 against 420');
  assert.match(got[0].detail, /83% below its normal 420 items/);
});

test('a low-volume workflow is never judged, however significant the move', () => {
  // Statistically, 11 to 7 is a real move. It is also four items, and mailing
  // anybody about it is how alerts get filtered.
  const base = baseline(historyBuckets(14, 11, { runs: 1 }), { now: NOW, ...ctx });
  assert.deepEqual(anomalies({ items: 2, itemsCovered: 1, avgMs: null }, base, { partialDay: 1 }), []);
});

test('a statistically real move that is a small percentage is not an anomaly', () => {
  const base = baseline(historyBuckets(14, 400), { now: NOW, ...ctx });
  // MAD is 0 here, so z is -99 — but 380 is only 5% down and the percentage
  // floor is what keeps it quiet.
  assert.deepEqual(anomalies({ items: 380, itemsCovered: 10, avgMs: null }, base, { dropPct: 40, partialDay: 1 }), []);
});

test('the baseline is scaled to how much of today has happened', () => {
  const base = baseline(historyBuckets(14, 480), { now: NOW, ...ctx });
  // Half a day gone, half the normal volume. Not an anomaly.
  assert.deepEqual(anomalies({ items: 240, itemsCovered: 10, avgMs: null }, base, { partialDay: 0.5 }), []);
  // Without the scaling this would read as a 50% collapse every lunchtime.
  const unscaled = anomalies({ items: 240, itemsCovered: 10, avgMs: null }, base, { partialDay: 1 });
  assert.equal(unscaled.length, 1);
});

test('a spike has to double before it is worth saying', () => {
  const base = baseline(historyBuckets(14, 400), { now: NOW, ...ctx });
  assert.deepEqual(anomalies({ items: 600, itemsCovered: 10, avgMs: null }, base, { partialDay: 1 }), []);
  const got = anomalies({ items: 1600, itemsCovered: 10, avgMs: null }, base, { partialDay: 1 });
  assert.equal(got[0].kind, 'volume-spike');
});

test('a runtime that has run away is its own anomaly', () => {
  const base = baseline(historyBuckets(14, 400, { runs: 10, msSum: 10000 }), { now: NOW, ...ctx });
  assert.equal(base.avgMs.median, 1000);
  const got = anomalies({ items: 400, itemsCovered: 10, avgMs: 1480 }, base, { partialDay: 1 });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'runtime-up');
  assert.equal(got[0].pct, 48);
});

test('no baseline means no anomaly, rather than a guess from two numbers', () => {
  assert.deepEqual(anomalies({ items: 0, itemsCovered: 1 }, { ok: false, days: 2 }, {}), []);
});

/* -------------------------------------------------------------- health */

const wf = (over = {}) => ({
  id: 'aaaaaaaaaaaa', key: 'main__aaaaaaaaaaaa', instance: 'main', name: 'Test',
  expectedIntervalMin: 60, staleAfterMin: 135, minimumItems: 1,
  consecutiveFailures: 3, failureRatePct: 10, anomalyDropPct: 40, ...over,
});

const row = (over = {}) => ({
  id: '1', status: 'success', startedAt: '2026-10-04T12:00:00Z', ms: 1000, items: 100, volumeSource: 'node-data', ...over,
});

const stats = (over = {}) => ({
  executions: 10, successful: 10, failed: 0, failureRate: 0, items: 1000, itemsCovered: 10,
  itemsComplete: true, avgMs: 1000, rows: [], ...over,
});

test('counting failures backwards from now stops at the first success', () => {
  assert.equal(consecutiveFailures([
    row({ status: 'error' }), row({ status: 'error' }), row({ status: 'success' }), row({ status: 'error' }),
  ]), 2);
  assert.equal(consecutiveFailures([
    row({ status: 'error' }), row({ status: 'running' }), row({ status: 'error' }),
  ]), 2, 'an execution still in flight is neither, and does not break the streak');
  assert.equal(consecutiveFailures([row()]), 0);
});

test('HEALTHY is executed recently, succeeding, and producing normal volume', () => {
  const h = health(wf(), {
    stats: stats(), base: baseline(historyBuckets(14, 1000), { now: NOW, ...ctx }),
    now: NOW, allRows: [row({ startedAt: '2026-10-04T12:20:00Z' })],
  });
  assert.equal(h.state, 'HEALTHY');
  assert.match(h.reasons[0].why, /10 of 10 executions succeeded/);
});

test('STALE is "has not run", which an inventory can never tell you', () => {
  // The workflow is switched on. It has simply not fired for three hours.
  const h = health(wf(), {
    stats: stats(), base: { ok: true, days: 14 }, now: NOW,
    allRows: [row({ startedAt: '2026-10-04T09:00:00Z' })],
  });
  assert.equal(h.state, 'STALE');
  assert.match(h.reasons[0].why, /past its 2h staleness window/);
});

test('past twice the staleness window it is CRITICAL, not still a warning', () => {
  const h = health(wf(), {
    stats: stats(), base: { ok: true, days: 14 }, now: NOW,
    allRows: [row({ startedAt: '2026-10-03T12:00:00Z' })],
  });
  assert.equal(h.state, 'CRITICAL');
});

test('a webhook workflow is not stale because nobody filled the form', () => {
  const h = health(wf({ expectedIntervalMin: null, staleAfterMin: null }), {
    stats: stats(), base: { ok: true, days: 14 }, now: NOW,
    allRows: [row({ startedAt: '2026-09-20T12:00:00Z' })],
  });
  assert.equal(h.state, 'HEALTHY', 'no declared schedule means no staleness claim');
});

test('CRITICAL at the configured consecutive-failure limit, and it names the node', () => {
  const rows = [
    row({ status: 'error', failedNode: 'CRM Insert' }), row({ status: 'error' }), row({ status: 'error' }),
  ];
  const h = health(wf(), {
    stats: stats({ failed: 3, successful: 7, failureRate: 30 }), base: { ok: true, days: 14 }, now: NOW, allRows: rows,
  });
  assert.equal(h.state, 'CRITICAL');
  assert.match(h.reasons.map((r) => r.why).join(' '), /3 consecutive failures.*CRM Insert/);
});

test('an intermittent failure rate is a WARNING, not a page', () => {
  const h = health(wf(), {
    stats: stats({ failed: 2, successful: 18, executions: 20, failureRate: 10.5 }),
    base: { ok: true, days: 14 }, now: NOW,
    allRows: [row(), row({ status: 'error' })],
  });
  assert.equal(h.state, 'WARNING');
});

test('NO DATA is succeeding and producing nothing — invisible to any status check', () => {
  const rows = [row({ items: 0 }), row({ items: 0 }), row({ items: 0 })];
  const h = health(wf(), {
    stats: stats({ items: 0, itemsCovered: 3 }), base: { ok: true, days: 14 }, now: NOW, allRows: rows,
  });
  assert.equal(h.state, 'NO DATA');
  assert.match(h.reasons[0].why, /produced no items at all/);
});

test('zero-data is only judged when a minimum was declared', () => {
  const rows = [row({ items: 0 }), row({ items: 0 }), row({ items: 0 })];
  const h = health(wf({ minimumItems: 0 }), {
    stats: stats({ items: 0, itemsCovered: 3 }), base: { ok: true, days: 14 }, now: NOW, allRows: rows,
  });
  assert.equal(h.state, 'HEALTHY', 'a workflow with no volume expectation is not failing by producing none');
});

test('UNKNOWN when nothing has been collected — never HEALTHY by default', () => {
  const h = health(wf(), { stats: stats({ executions: 0, successful: 0, items: 0, itemsCovered: 0 }), base: { ok: false, days: 0 }, now: NOW, allRows: [] });
  assert.equal(h.state, 'UNKNOWN');
  assert.match(h.reasons[0].why, /no executions have been collected/);
});

test('UNKNOWN on too little history, rather than a reassuring green', () => {
  const h = health(wf({ expectedIntervalMin: null, staleAfterMin: null }), {
    stats: stats({ executions: 2, successful: 2 }), base: { ok: false, days: 1 }, now: NOW, allRows: [row(), row()],
  });
  assert.equal(h.state, 'UNKNOWN');
});

test('a severe volume drop escalates past WARNING', () => {
  const h = health(wf(), {
    stats: stats(), base: { ok: true, days: 14 }, now: NOW, allRows: [row()],
    anomalyList: [{ kind: 'volume-drop', pct: 83, detail: '83% below normal', severity: 'high' }],
  });
  assert.equal(h.state, 'CRITICAL', '83% is past 40 x 1.75');

  const mild = health(wf(), {
    stats: stats(), base: { ok: true, days: 14 }, now: NOW, allRows: [row()],
    anomalyList: [{ kind: 'volume-drop', pct: 45, detail: '45% below normal', severity: 'high' }],
  });
  assert.equal(mild.state, 'WARNING');
});

/* -------------------------------------------------------- roll-ups */

test('overview counts health states and weights the mean by executions', () => {
  const analysed = [
    { workflow: wf(), stats: stats({ executions: 10, avgMs: 1000, failed: 0 }), anomalies: [], health: { state: 'HEALTHY' } },
    { workflow: wf({ project: 'yamini' }), stats: stats({ executions: 90, avgMs: 2000, failed: 9, items: 500, bytes: 10 }), anomalies: [{ kind: 'volume-drop' }], health: { state: 'CRITICAL' } },
  ];
  const t = overview(analysed);
  assert.equal(t.workflows, 2);
  assert.equal(t.executions, 100);
  assert.equal(t.failed, 9);
  assert.equal(t.failureRate, 9);
  assert.equal(t.avgMs, 1900, 'weighted by executions, not a mean of means');
  assert.equal(t.anomalous, 1);
  assert.deepEqual([t.byHealth.HEALTHY, t.byHealth.CRITICAL], [1, 1]);
});

test('project roll-up keeps unclaimed workflows visible instead of dropping them', () => {
  const rows = byProject([
    { workflow: wf({ project: 'yamini' }), stats: stats({ items: 500, executions: 5, failed: 0 }), anomalies: [], health: { state: 'HEALTHY' } },
    { workflow: wf({ project: null }), stats: stats({ items: 10, executions: 1, failed: 1 }), anomalies: [], health: { state: 'WARNING' } },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].project, 'yamini');
  assert.equal(rows[1].label, 'No project');
});

/* ------------------------------------------------- collector mechanics */

test('buckets are built from rows, counting coverage separately from executions', () => {
  const got = bucketsFrom([
    { status: 'success', startedAt: '2026-10-04T09:10:00Z', ms: 1000, items: 100, bytes: 50 },
    { status: 'success', startedAt: '2026-10-04T09:40:00Z', ms: 2000, bytes: 50 },
    { status: 'error', startedAt: '2026-10-04T09:50:00Z', ms: 500 },
  ], TZ);
  const b = got['2026-10-04T09'];
  assert.deepEqual(b, { n: 3, ok: 2, fail: 1, items: 100, bytes: 100, msSum: 3500, msMax: 2000, covered: 1 });
});

test('a bucket keeps its numbers when the rows underneath it age out', () => {
  // The whole reason `buckets` exists as a second tier. Recomputing from the
  // surviving rows alone would silently halve a partially-pruned hour.
  const stored = { '2026-10-04T09': { n: 10, ok: 10, fail: 0, items: 1000, bytes: 0, msSum: 10000, msMax: 900, covered: 10 } };
  const fresh = { '2026-10-04T09': { n: 4, ok: 4, fail: 0, items: 400, bytes: 0, msSum: 4000, msMax: 900, covered: 4 } };
  assert.equal(mergeBuckets(stored, fresh)['2026-10-04T09'].n, 10);
  assert.equal(mergeBuckets(stored, fresh)['2026-10-04T09'].items, 1000);
});

test('a growing bucket takes the newer, larger numbers', () => {
  const stored = { '2026-10-04T09': { n: 4, ok: 4, fail: 0, items: 400, bytes: 0, msSum: 4000, msMax: 900, covered: 4 } };
  const fresh = { '2026-10-04T09': { n: 6, ok: 5, fail: 1, items: 600, bytes: 0, msSum: 6000, msMax: 1200, covered: 6 } };
  const merged = mergeBuckets(stored, fresh)['2026-10-04T09'];
  assert.equal(merged.n, 6);
  assert.equal(merged.fail, 1);
  assert.equal(merged.msMax, 1200);
});

test('retention bounds rows by age AND by count, newest kept', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({
    id: String(i), status: 'success', volumeSource: 'node-data',
    startedAt: new Date(NOW.getTime() - i * 3600000).toISOString(),
    nodes: { A: { items: 1 } },
  }));
  const kept = pruneRows(rows, { rawDays: 2, maxRows: 100, keepNodeDetail: 10 }, NOW);
  assert.ok(kept.length <= 49, `48 hours of hourly rows, got ${kept.length}`);
  assert.equal(kept[0].id, '0', 'newest first');
  assert.ok(kept[0].nodes, 'node detail on the newest rows');
  assert.equal(kept[20].nodes, undefined, 'and dropped past keepNodeDetail — it is the bulk of a row');
  assert.equal(kept[20].nodesDropped, true, 'but the fact that it existed is recorded');
});

test('node detail is kept on every failure, however old', () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `ok${i}`, status: 'success', startedAt: new Date(NOW.getTime() - i * 60000).toISOString(), nodes: { A: { items: 1 } },
    })),
    { id: 'bad', status: 'error', startedAt: new Date(NOW.getTime() - 50 * 60000).toISOString(), nodes: { A: { items: 0 } }, error: 'boom' },
  ];
  const kept = pruneRows(rows, { rawDays: 30, maxRows: 100, keepNodeDetail: 5 }, NOW);
  assert.ok(kept.find((r) => r.id === 'bad').nodes, 'an error is worth keeping for as long as the row is');
});

test('a maxRows cap never costs a bucket its history', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    id: String(i), status: 'success', volumeSource: 'node-data', items: 10,
    startedAt: new Date(NOW.getTime() - i * 60000).toISOString(),
  }));
  const full = bucketsFrom(rows, TZ);
  const capped = bucketsFrom(pruneRows(rows, { rawDays: 30, maxRows: 10, keepNodeDetail: 5 }, NOW), TZ);
  const merged = mergeBuckets(full, capped);
  for (const [key, b] of Object.entries(full)) assert.equal(merged[key].n, b.n, key);
});

test('buckets are pruned on their own, much longer clock', () => {
  const old = { '2025-01-01T09': { n: 1 }, '2026-10-04T09': { n: 1 } };
  const kept = pruneBuckets(old, { bucketDays: 400 }, NOW);
  assert.deepEqual(Object.keys(kept), ['2026-10-04T09']);
});

test('the node-detail budget spends on failures first, then the newest', () => {
  const rows = [
    { id: '10', status: 'success', startedAt: '2026-10-04T12:00:00Z', volumeSource: 'bytes' },
    { id: '9', status: 'success', startedAt: '2026-10-04T11:00:00Z', volumeSource: 'bytes' },
    { id: '8', status: 'error', startedAt: '2026-10-04T08:00:00Z', volumeSource: 'bytes' },
    { id: '7', status: 'success', startedAt: '2026-10-04T07:00:00Z', volumeSource: 'node-data', items: 5 },
    { id: '6', status: 'error', startedAt: '2026-10-04T06:00:00Z', volumeSource: 'bytes', detailTried: true },
  ];
  assert.deepEqual(detailCandidates(rows, 2).map((r) => r.id), ['8', '10'],
    'the failure first — its node and message exist nowhere else');
  assert.deepEqual(detailCandidates(rows, 10).map((r) => r.id), ['8', '10', '9'],
    'a row already tried is never retried, and one that has node data needs none');
  assert.deepEqual(detailCandidates(rows, 0), []);
});

/* -------------------------------------------------- per-stage volume */

test('checkpoints are counted per stage per hour, which the funnel cannot do', () => {
  // "How much went from Cratio to Meta?" is a question about a named stage.
  // "In which hour?" makes it a question about a named stage over time, and
  // the funnel sums over executions so it can only ever answer the first.
  const got = bucketsFrom([
    { status: 'success', startedAt: '2026-10-04T09:10:00Z', items: 5240, checkpoints: { 'Fetch from Cratio': 5240, 'Meta CAPI': 4701 } },
    { status: 'success', startedAt: '2026-10-04T09:50:00Z', items: 3000, checkpoints: { 'Fetch from Cratio': 3000, 'Meta CAPI': 2900 } },
    { status: 'error', startedAt: '2026-10-04T10:10:00Z', items: 4000, checkpoints: { 'Fetch from Cratio': 4000, 'Meta CAPI': 0 } },
  ], TZ);

  assert.deepEqual(got['2026-10-04T09'].cp, { 'Fetch from Cratio': 8240, 'Meta CAPI': 7601 });
  assert.deepEqual(got['2026-10-04T10'].cp, { 'Fetch from Cratio': 4000, 'Meta CAPI': 0 },
    'a stage that produced nothing is 0, which is the finding');
});

test('a checkpoint that did not run contributes nothing, not a zero', () => {
  // "the CRM insert never happened" and "the CRM insert produced nothing" are
  // different problems, and only one of them is a code bug.
  const got = bucketsFrom([
    { status: 'success', startedAt: '2026-10-04T09:10:00Z', items: 10, checkpoints: { 'Meta CAPI': null } },
  ], TZ);
  assert.equal(got['2026-10-04T09'].cp, undefined);
});

test('a row with no checkpoints leaves the bucket without a cp at all', () => {
  const got = bucketsFrom([{ status: 'success', startedAt: '2026-10-04T09:10:00Z', items: 10 }], TZ);
  assert.equal('cp' in got['2026-10-04T09'], false, 'an empty object would claim stages were tracked');
});

test('stage totals survive the rows ageing out, per stage', () => {
  const stored = { '2026-10-04T09': { n: 10, ok: 10, fail: 0, items: 1000, bytes: 0, msSum: 0, msMax: 0, covered: 10, cp: { A: 900, B: 800 } } };
  const fresh = { '2026-10-04T09': { n: 4, ok: 4, fail: 0, items: 400, bytes: 0, msSum: 0, msMax: 0, covered: 4, cp: { A: 360, C: 50 } } };
  const merged = mergeBuckets(stored, fresh)['2026-10-04T09'];
  assert.equal(merged.cp.A, 900, 'the stored figure was computed when more rows existed');
  assert.equal(merged.cp.B, 800, 'a stage missing from this pass keeps its history');
  assert.equal(merged.cp.C, 50, 'a stage added to the workflow today appears from today');
});

test('stageSeries puts each stage against the clock, busiest first', () => {
  const buckets = {
    '2026-10-04T09': { n: 2, items: 8240, cp: { 'Fetch from Cratio': 8240, 'Meta CAPI': 7601 } },
    '2026-10-04T10': { n: 1, items: 4000, cp: { 'Fetch from Cratio': 4000, 'Meta CAPI': 0 } },
  };
  const got = stageSeries(buckets, {
    from: new Date('2026-10-04T09:00:00Z'), to: new Date('2026-10-04T11:00:00Z'), grain: 'hour', ...ctx,
  });

  assert.deepEqual(got.stages, ['Fetch from Cratio', 'Meta CAPI']);
  assert.deepEqual(got.totals, { 'Fetch from Cratio': 12240, 'Meta CAPI': 7601 });
  assert.equal(got.points.length, 3);
  assert.deepEqual(got.points[1].byStage, { 'Fetch from Cratio': 4000, 'Meta CAPI': 0 },
    'the hour it stopped reaching Meta is the whole point');
  assert.deepEqual(got.points[2].byStage, { 'Fetch from Cratio': 0, 'Meta CAPI': 0 },
    'an hour with no data is a point on the chart, not a gap');
});

test('stageSeries honours the registered checkpoint list even before data arrives', () => {
  const got = stageSeries({}, {
    from: new Date('2026-10-04T09:00:00Z'), to: new Date('2026-10-04T10:00:00Z'), grain: 'hour',
    stages: ['Fetch from Cratio', 'Meta CAPI'], ...ctx,
  });
  assert.deepEqual(got.stages.sort(), ['Fetch from Cratio', 'Meta CAPI']);
  assert.deepEqual(got.points[0].byStage, { 'Fetch from Cratio': 0, 'Meta CAPI': 0 });
});

test('no checkpoints anywhere means no stage chart, rather than an empty one', () => {
  assert.equal(stageSeries({ '2026-10-04T09': { n: 1, items: 5 } }, {
    from: new Date('2026-10-04T09:00:00Z'), to: new Date('2026-10-04T10:00:00Z'), ...ctx,
  }), null);
});

test('stageSeries folds to daily for a long range', () => {
  const buckets = {
    '2026-10-03T09': { n: 1, items: 100, cp: { A: 100 } },
    '2026-10-03T15': { n: 1, items: 200, cp: { A: 200 } },
    '2026-10-04T09': { n: 1, items: 50, cp: { A: 50 } },
  };
  const got = stageSeries(buckets, {
    from: new Date('2026-10-03T00:00:00Z'), to: new Date('2026-10-04T23:00:00Z'), grain: 'day', ...ctx,
  });
  assert.equal(got.points.length, 2);
  assert.equal(got.points[0].byStage.A, 300);
  assert.equal(got.points[1].byStage.A, 50);
});

/* ------------------------------------------------------------- facade */

test('analyse joins it all up for one workflow in one window', () => {
  const a = analyse(wf(), store({ buckets: { ...BUCKETS, ...historyBuckets(14, 1100) } }), {
    now: NOW, range: '24h', ...ctx,
  });
  assert.equal(a.range.id, '24h');
  assert.equal(a.stats.executions, 12);
  assert.equal(a.baseline.ok, true);
  assert.ok(['HEALTHY', 'WARNING', 'STALE', 'CRITICAL', 'NO DATA', 'UNKNOWN'].includes(a.health.state));
});

test('an empty store analyses to UNKNOWN without throwing', () => {
  const a = analyse(wf(), { rows: [], buckets: {}, sync: {} }, { now: NOW, range: '24h', ...ctx });
  assert.equal(a.stats.executions, 0);
  assert.equal(a.health.state, 'UNKNOWN');
  assert.equal(a.baseline.ok, false);
  assert.deepEqual(a.anomalies, []);
});

test('an unknown range falls back to 24h rather than crashing the build', () => {
  assert.equal(rangeById('nonsense').id, '24h');
  assert.equal(rangeById('7d').hours, 168);
});

test('durations read the way somebody says them out loud', () => {
  assert.equal(formatMins(null), 'never');
  assert.equal(formatMins(0), 'under a minute');
  assert.equal(formatMins(45), '45 min');
  assert.equal(formatMins(150), '3h');
  assert.equal(formatMins(4320), '3d');
});

/* ------------------------------------------- what is worth reading in full */

const exec = (id, status, bytes, minsAgo) => ({
  id: String(id), status, bytes,
  startedAt: new Date(Date.parse('2026-10-04T12:00:00Z') - minsAgo * 60000).toISOString(),
});

test('every failure is read, however large — an error must be explainable', () => {
  // The payload is the only place the error message and the failed node
  // exist. "Something broke and we did not look" is not an acceptable saving.
  const picked = detailCandidates([exec('FAIL', 'error', 9 * 1024 * 1024, 0)], 60);
  assert.deepEqual(picked.map((r) => r.id), ['FAIL']);
});

test('one huge failure does not starve the cheap successes behind it', () => {
  // Sharing a single allowance meant a nine-megabyte failure consumed all of
  // it and every small, common success was dropped to pay for one rare
  // expensive row.
  const picked = detailCandidates([
    exec('FAIL', 'error', 9 * 1024 * 1024, 0),
    ...Array.from({ length: 20 }, (_, i) => exec(`ok${i}`, 'success', 150 * 1024, i + 1)),
  ], 60);
  assert.ok(picked.some((r) => r.id === 'FAIL'), 'the failure is read');
  assert.ok(picked.filter((r) => r.status === 'success').length >= 8,
    `successes survive it, got ${picked.filter((r) => r.status === 'success').length}`);
});

test('a workflow whose every payload is huge still gets one, not none', () => {
  // Skipping oversized successes is right — a funnel from a 5 MB execution
  // says nothing a 200 KB one does not. Skipping ALL of them is a regression
  // wearing a performance badge: no funnel, no item count, ever.
  const picked = detailCandidates(
    Array.from({ length: 40 }, (_, i) => exec(`s${i}`, 'success', 3 * 1024 * 1024, i)), 60,
  );
  assert.equal(picked.length, 1, 'one fetch instead of ten is the win; zero is a loss');
  assert.equal(picked[0].id, 's0', 'and it is the newest, because a funnel describes the current shape');
});

test('oversized successes are skipped when cheap ones are available', () => {
  const picked = detailCandidates([
    exec('huge', 'success', 5 * 1024 * 1024, 0),
    ...Array.from({ length: 12 }, (_, i) => exec(`ok${i}`, 'success', 80 * 1024, i + 1)),
  ], 60);
  assert.equal(picked.some((r) => r.id === 'huge'), false);
  // Nine, not ten: the sample is capped at ten CANDIDATES before the size
  // filter runs, so dropping the oversized one leaves nine. Reaching further
  // back to top the sample up would buy a tenth funnel sample nobody needs.
  assert.equal(picked.length, 9);
});
