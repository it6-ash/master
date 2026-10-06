/**
 * Everything the dashboard and the email report ask of the collected data.
 *
 * Pure functions over a store (data/runs/<key>.json). No I/O, no clock of its
 * own — `now` is always passed in — so every rule in here is testable against
 * a fixture, which is the only way claims like "82.9% below normal" are worth
 * printing.
 *
 * Aggregation happens HERE, at build time, and only the aggregates reach the
 * page. The browser never sees a raw execution list for the sake of drawing a
 * chart.
 */

/* ------------------------------------------------------------- windows */

export const RANGES = [
  { id: '1h', label: '1 hour', hours: 1, grain: 'hour' },
  { id: '6h', label: '6 hours', hours: 6, grain: 'hour' },
  { id: '12h', label: '12 hours', hours: 12, grain: 'hour' },
  { id: '24h', label: '24 hours', hours: 24, grain: 'hour' },
  { id: '7d', label: '7 days', hours: 24 * 7, grain: 'hour' },
  { id: '30d', label: '30 days', hours: 24 * 30, grain: 'day' },
  { id: '90d', label: '90 days', hours: 24 * 90, grain: 'week' },
];

export const rangeById = (id) => RANGES.find((r) => r.id === id) ?? RANGES[3];

/**
 * Bucket keys covering [from, to], oldest first.
 *
 * Stepping one UTC hour at a time and mapping each instant to its key in the
 * target zone is correct for every real offset — they are all whole multiples
 * of fifteen minutes, so the two hour grids have the same spacing and no key
 * can be skipped. Dedupe covers the DST hour that repeats.
 */
export function hourKeys(from, to, tz, bucketKey) {
  const keys = [];
  const seen = new Set();
  // Snapped down to the hour, then stepped to `to` and no further. Running a
  // step past the end looks like harmless slack and is not: it emits a bucket
  // that has not happened yet, which draws an empty bar at the right edge of
  // every chart on the page and reads as "it has just stopped". Snapping down
  // already guarantees the hour containing `to` is included.
  const start = Math.floor(from.getTime() / 3600000) * 3600000;
  for (let t = start; t <= to.getTime(); t += 3600000) {
    const key = bucketKey(new Date(t).toISOString(), tz);
    if (key && !seen.has(key)) { seen.add(key); keys.push(key); }
  }
  return keys;
}

const emptyPoint = (key) => ({ key, n: 0, ok: 0, fail: 0, items: 0, bytes: 0, msSum: 0, msMax: 0, covered: 0 });

const addPoint = (into, b) => {
  into.n += b.n ?? 0;
  into.ok += b.ok ?? 0;
  into.fail += b.fail ?? 0;
  into.items += b.items ?? 0;
  into.bytes += b.bytes ?? 0;
  into.msSum += b.msSum ?? 0;
  into.msMax = Math.max(into.msMax, b.msMax ?? 0);
  into.covered += b.covered ?? 0;
  return into;
};

/**
 * A time series at the requested grain, with empty buckets present rather
 * than skipped — an hour with no executions is the most important shape on
 * the chart, and omitting it draws a continuous line through an outage.
 *
 * @returns {Array<{key, n, ok, fail, items, bytes, msSum, msMax, covered}>}
 */
export function series(buckets, { from, to, grain = 'hour', tz = 'UTC', bucketKey }) {
  const keys = hourKeys(from, to, tz, bucketKey);
  if (grain === 'hour') {
    return keys.map((key) => addPoint(emptyPoint(key), buckets[key] ?? {}));
  }

  const group = (key) => {
    if (grain === 'day') return key.slice(0, 10);
    // ISO-ish weeks, Monday-start, labelled by the Monday's date.
    const d = new Date(`${key.slice(0, 10)}T00:00:00Z`);
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
    return monday.toISOString().slice(0, 10);
  };

  const out = new Map();
  for (const key of keys) {
    const g = group(key);
    if (!out.has(g)) out.set(g, emptyPoint(g));
    addPoint(out.get(g), buckets[key] ?? {});
  }
  return [...out.values()];
}

/* --------------------------------------------------- stage volume */

/**
 * How much data each named stage moved, bucket by bucket.
 *
 * This is the "Cratio to Meta, in which hour" question, and it is a different
 * question from the funnel. The funnel sums over executions and answers "where
 * does my data disappear"; this answers "when did it go, and how much reached
 * each destination" — so a drop that only happens between 02:00 and 04:00 is
 * visible as a shape rather than averaged into a healthy-looking total.
 *
 * Stages come from the workflow's registered `checkpoints`, which are n8n node
 * names. A stage absent from a bucket is 0 for that bucket and not a gap: an
 * hour in which nothing reached Meta is the finding.
 *
 * @returns {{ stages: string[], points: Array<{key, total, byStage: Record<string, number>}> }|null}
 */
export function stageSeries(buckets, { from, to, grain = 'hour', tz, bucketKey, stages = null }) {
  const keys = hourKeys(from, to, tz, bucketKey);
  const present = new Set(stages ?? []);
  if (!stages) {
    for (const key of keys) for (const node of Object.keys(buckets?.[key]?.cp ?? {})) present.add(node);
  }
  if (!present.size) return null;

  const group = (key) => {
    if (grain === 'hour') return key;
    if (grain === 'day') return key.slice(0, 10);
    const d = new Date(`${key.slice(0, 10)}T00:00:00Z`);
    return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  };

  const out = new Map();
  for (const key of keys) {
    const g = group(key);
    if (!out.has(g)) {
      out.set(g, { key: g, total: 0, byStage: Object.fromEntries([...present].map((n) => [n, 0])) });
    }
    const point = out.get(g);
    const cp = buckets?.[key]?.cp ?? {};
    for (const node of present) {
      const v = cp[node] ?? 0;
      point.byStage[node] += v;
    }
    point.total += buckets?.[key]?.items ?? 0;
  }

  // Ordered by volume, so the busiest stage leads and a destination receiving
  // nothing sorts to the bottom where it is conspicuous.
  const totals = new Map([...present].map((n) => [n, 0]));
  for (const p of out.values()) for (const [n, v] of Object.entries(p.byStage)) totals.set(n, totals.get(n) + v);

  return {
    stages: [...present].sort((a, b) => totals.get(b) - totals.get(a)),
    totals: Object.fromEntries(totals),
    points: [...out.values()],
  };
}

/* ------------------------------------------------------- percentiles */

/** Nearest-rank percentile on a sorted array. p is 0..100. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (rank - low));
}

export const median = (values) => percentile([...values].sort((a, b) => a - b), 50);

/**
 * Median absolute deviation. The robust spread: one catastrophic day does not
 * widen the band enough to hide the next one, which is exactly what a standard
 * deviation does on this kind of data.
 */
export function mad(values) {
  if (values.length < 2) return 0;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/* --------------------------------------------------------- window stats */

/**
 * Totals and runtime distribution for one window.
 *
 * Percentiles need individual durations, which only exist for as long as the
 * rows do. Past raw retention the buckets still give an exact count, an exact
 * item total, a true mean and a true maximum — so the window reports those and
 * says the percentiles are unavailable rather than computing them off a mean.
 */
export function windowStats(store, { from, to, tz, bucketKey }) {
  const points = series(store.buckets ?? {}, { from, to, grain: 'hour', tz, bucketKey });

  const totals = points.reduce(addPoint, emptyPoint('window'));
  const rows = (store.rows ?? []).filter((r) => {
    const at = Date.parse(r.startedAt ?? '');
    return Number.isFinite(at) && at >= from.getTime() && at <= to.getTime();
  });

  const durations = rows.map((r) => r.ms).filter(Number.isFinite).sort((a, b) => a - b);
  // Rows cover the window only if they account for every execution the buckets
  // counted. One missing row makes a percentile a claim about a subset.
  const rowsComplete = rows.length >= totals.n && totals.n > 0;

  const failureRate = totals.n > 0 ? (totals.fail / totals.n) * 100 : null;
  const newest = rows[0] ?? (store.rows ?? [])[0] ?? null;

  return {
    executions: totals.n,
    successful: totals.ok,
    failed: totals.fail,
    failureRate,
    items: totals.items,
    itemsCovered: totals.covered,
    itemsComplete: totals.n > 0 && totals.covered >= totals.n,
    bytes: totals.bytes,
    avgMs: totals.n > 0 && totals.msSum > 0 ? Math.round(totals.msSum / totals.n) : null,
    maxMs: totals.msMax || null,
    medianMs: rowsComplete ? percentile(durations, 50) : null,
    p95Ms: rowsComplete && durations.length >= 4 ? percentile(durations, 95) : null,
    runtimeFromRows: rowsComplete,
    // items / minute over the window, the throughput figure.
    throughput: (() => {
      const minutes = (to.getTime() - from.getTime()) / 60000;
      return minutes > 0 && totals.covered > 0 ? Number((totals.items / minutes).toFixed(2)) : null;
    })(),
    itemsPerExecution: totals.covered > 0 ? Math.round(totals.items / totals.covered) : null,
    lastRun: newest ? { id: newest.id, at: newest.startedAt, status: newest.status, items: newest.items ?? null } : null,
    rows,
    points,
  };
}

/* ------------------------------------------------------------ baseline */

/**
 * What "normal" looks like for this workflow, from its own history.
 *
 * Median and MAD over complete DAILY totals, excluding today — a day in
 * progress is always below a full day and would read as a permanent anomaly.
 * Seven complete days is the floor; below that there is no baseline, and
 * saying so is better than inventing a band from two numbers.
 */
export function baseline(buckets, { now, lookbackDays = 28, minDays = 7, tz, bucketKey }) {
  const today = bucketKey(new Date(now).toISOString(), tz)?.slice(0, 10);
  const daily = new Map();
  for (const [key, b] of Object.entries(buckets ?? {})) {
    const day = key.slice(0, 10);
    if (day === today) continue;
    const row = daily.get(day) ?? { items: 0, n: 0, msSum: 0, covered: 0 };
    row.items += b.items ?? 0;
    row.n += b.n ?? 0;
    row.msSum += b.msSum ?? 0;
    row.covered += b.covered ?? 0;
    daily.set(day, row);
  }

  const cutoff = new Date(new Date(now).getTime() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const days = [...daily.entries()].filter(([day]) => day >= cutoff).sort();
  if (days.length < minDays) return { ok: false, days: days.length, minDays };

  const itemDays = days.filter(([, r]) => r.covered > 0).map(([, r]) => r.items);
  const runDays = days.map(([, r]) => r.n);
  const runtimeDays = days.filter(([, r]) => r.n > 0 && r.msSum > 0).map(([, r]) => r.msSum / r.n);

  return {
    ok: true,
    days: days.length,
    items: itemDays.length >= minDays
      ? { median: median(itemDays), mad: mad(itemDays), samples: itemDays.length }
      : null,
    executions: { median: median(runDays), mad: mad(runDays), samples: runDays.length },
    avgMs: runtimeDays.length >= minDays
      ? { median: Math.round(median(runtimeDays)), mad: Math.round(mad(runtimeDays)) }
      : null,
  };
}

/**
 * The modified z-score (Iglewicz & Hoaglin): 0.6745 * (x - median) / MAD.
 * |z| > 3.5 is the published threshold for an outlier, and it is used as
 * published rather than tuned, because a tuned constant on this little data is
 * a guess wearing a decimal point.
 */
export function modifiedZ(value, { median: m, mad: d }) {
  if (!Number.isFinite(value) || !Number.isFinite(m)) return null;
  // MAD of zero means a dead-flat history. Fall back to a proportional test so
  // a workflow that produced exactly 500 items for a fortnight and then 50 is
  // still flagged, instead of dividing by nothing.
  if (!d) return m === 0 ? 0 : (value === m ? 0 : (value < m ? -99 : 99));
  return Number((0.6745 * (value - m) / d).toFixed(2));
}

const OUTLIER_Z = 3.5;

/**
 * Anomalies against the baseline, for today so far.
 *
 * Two guards against crying wolf, both of which this estate has already been
 * bitten by elsewhere:
 *
 *   - a percentage floor as well as a z-score. A statistically significant
 *     move from 11 items to 7 is not worth an email.
 *   - a low-volume floor. A workflow whose normal day is three items has no
 *     meaningful distribution, and every z-score it produces is noise.
 */
export function anomalies(stats, base, {
  dropPct = 40, minMedian = 20, partialDay = 1, minMs = 2000,
} = {}) {
  const out = [];
  if (!base?.ok) return out;

  if (base.items && stats.itemsCovered > 0 && base.items.median >= minMedian) {
    // Scale the baseline to the fraction of a day actually elapsed, or every
    // morning reports a collapse.
    const expected = base.items.median * partialDay;
    const z = modifiedZ(stats.items, { median: expected, mad: base.items.mad * Math.max(partialDay, 0.25) });
    const delta = expected > 0 ? ((stats.items - expected) / expected) * 100 : 0;
    if (z !== null && z <= -OUTLIER_Z && delta <= -dropPct) {
      out.push({
        kind: 'volume-drop', severity: 'high', metric: 'items', z,
        pct: Math.round(Math.abs(delta)), observed: stats.items, expected: Math.round(expected),
        detail: `${Math.round(Math.abs(delta))}% below its normal ${Math.round(expected).toLocaleString('en-US')} items`,
      });
    } else if (z !== null && z >= OUTLIER_Z && delta >= 100) {
      out.push({
        kind: 'volume-spike', severity: 'medium', metric: 'items', z,
        pct: Math.round(delta), observed: stats.items, expected: Math.round(expected),
        detail: `${Math.round(delta)}% above its normal ${Math.round(expected).toLocaleString('en-US')} items`,
      });
    }
  }

  // The same low-volume floor the items branch has, for the same reason. A
  // WhatsApp reply bot whose normal run is 0.658s doubled to 1.343s and mailed
  // seven people a WARNING about 685 milliseconds. Statistically it is a real
  // outlier; operationally it is nothing, and an alert nobody can act on is
  // how a mail everybody reads becomes a mail everybody filters.
  if (base.avgMs && stats.avgMs && base.avgMs.median >= minMs) {
    const z = modifiedZ(stats.avgMs, base.avgMs);
    const delta = ((stats.avgMs - base.avgMs.median) / base.avgMs.median) * 100;
    if (z !== null && z >= OUTLIER_Z && delta >= 40) {
      out.push({
        kind: 'runtime-up', severity: 'medium', metric: 'avgMs', z,
        pct: Math.round(delta), observed: stats.avgMs, expected: base.avgMs.median,
        detail: `average runtime up ${Math.round(delta)}% on its normal ${(base.avgMs.median / 1000).toFixed(1)}s`,
      });
    }
  }

  return out;
}

/* -------------------------------------------------------------- health */

export const HEALTH = ['CRITICAL', 'WARNING', 'STALE', 'NO DATA', 'UNKNOWN', 'HEALTHY'];
const RANK = { CRITICAL: 0, STALE: 1, 'NO DATA': 2, WARNING: 3, UNKNOWN: 4, HEALTHY: 5 };
export const worseOf = (a, b) => ((RANK[a] ?? 9) <= (RANK[b] ?? 9) ? a : b);

/**
 * How many of the most recent executions failed in a row.
 * Rows arrive newest-first, so this reads forwards and stops at the first
 * success — which is what "consecutive" means from the present backwards.
 */
export function consecutiveFailures(rows) {
  let n = 0;
  for (const row of rows) {
    if (row.status === 'error') n += 1;
    else if (row.status === 'success') break;
    // a running or waiting execution is neither, and does not break the streak
  }
  return n;
}

/**
 * Health, as a state plus the sentences that produced it.
 *
 * "Active" is not health. A workflow can be switched on and never fire, fire
 * and produce nothing, produce a tenth of normal, or take four times as long —
 * and all four look identical to an inventory. Every rule below is therefore
 * about what the executions actually did, and every one is configurable per
 * workflow in config/n8n.example.json.
 */
export function health(workflow, { stats, base, anomalyList = [], now, allRows = [] }) {
  const reasons = [];
  let state = 'HEALTHY';
  const worsen = (next, why) => { state = worseOf(state, next); reasons.push({ state: next, why }); };

  const rows = allRows.length ? allRows : stats.rows ?? [];
  const lastAt = rows[0]?.startedAt ? Date.parse(rows[0].startedAt) : null;
  const sinceMin = lastAt ? Math.floor((new Date(now).getTime() - lastAt) / 60000) : null;

  if (!rows.length && stats.executions === 0) {
    return {
      state: 'UNKNOWN',
      reasons: [{
        state: 'UNKNOWN',
        why: 'no executions have been collected yet. Either it has not run since monitoring started,'
          + ' or n8n had already pruned its history — run `npm run wf-sync` and look again after its next run.',
      }],
      sinceMin: null,
      consecutiveFailures: 0,
    };
  }

  /* staleness — only meaningful when a schedule was declared */
  const staleAfter = workflow.staleAfterMin;
  if (staleAfter && sinceMin !== null) {
    if (sinceMin > staleAfter * 2) {
      worsen('CRITICAL', `has not run for ${formatMins(sinceMin)}, more than twice its ${formatMins(staleAfter)} staleness window`);
    } else if (sinceMin > staleAfter) {
      worsen('STALE', `has not run for ${formatMins(sinceMin)}, past its ${formatMins(staleAfter)} staleness window`);
    } else if (workflow.expectedIntervalMin && sinceMin > workflow.expectedIntervalMin) {
      worsen('WARNING', `last run ${formatMins(sinceMin)} ago, against an expected ${formatMins(workflow.expectedIntervalMin)}`);
    }
  }

  /* failures */
  const streak = consecutiveFailures(rows);
  const limit = workflow.consecutiveFailures ?? 3;
  if (streak >= limit) {
    worsen('CRITICAL', `${streak} consecutive failures${rows[0]?.failedNode ? `, latest at the "${rows[0].failedNode}" node` : ''}`);
  } else if (stats.failureRate !== null && stats.failureRate > (workflow.failureRatePct ?? 10)) {
    worsen('WARNING', `${stats.failureRate.toFixed(1)}% of ${stats.executions} executions failed in this window`);
  } else if (streak > 0) {
    worsen('WARNING', `the most recent execution failed${rows[0]?.failedNode ? ` at the "${rows[0].failedNode}" node` : ''}`);
  }

  /* zero data — succeeding and producing nothing */
  const minimum = workflow.minimumItems ?? 0;
  if (minimum > 0) {
    const succeeded = rows.filter((r) => r.status === 'success' && Number.isFinite(r.items));
    const recent = succeeded.slice(0, 5);
    if (recent.length >= 3 && recent.every((r) => r.items < minimum)) {
      worsen('NO DATA', recent.every((r) => r.items === 0)
        ? `the last ${recent.length} successful runs produced no items at all`
        : `the last ${recent.length} successful runs produced fewer than ${minimum} items`);
    }
  }

  /* anomalies */
  for (const a of anomalyList) {
    if (a.kind === 'volume-drop' && a.pct >= (workflow.anomalyDropPct ?? 40) * 1.75) worsen('CRITICAL', a.detail);
    else worsen('WARNING', a.detail);
  }

  if (!base?.ok && state === 'HEALTHY' && stats.executions < 3) {
    return {
      state: 'UNKNOWN',
      reasons: [{ state: 'UNKNOWN', why: `only ${stats.executions} execution${stats.executions === 1 ? '' : 's'} collected — not enough to judge` }],
      sinceMin,
      consecutiveFailures: streak,
    };
  }

  if (state === 'HEALTHY') {
    reasons.push({
      state: 'HEALTHY',
      why: `${stats.successful} of ${stats.executions} executions succeeded`
        + `${stats.itemsCovered > 0 ? `, ${stats.items.toLocaleString('en-US')} items processed` : ''}`
        + `${sinceMin !== null ? `, last run ${formatMins(sinceMin)} ago` : ''}`,
    });
  }

  return { state, reasons, sinceMin, consecutiveFailures: streak };
}

export function formatMins(mins) {
  if (mins == null) return 'never';
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

/* -------------------------------------------------------------- facade */

/**
 * Everything about one workflow in one window. This is the shape the renderer
 * and the email report both consume, so there is one definition of each figure.
 */
export function analyse(workflow, store, { now, range = '24h', tz, bucketKey }) {
  const r = rangeById(range);
  const to = new Date(now);
  const from = new Date(to.getTime() - r.hours * 3600000);

  const stats = windowStats(store, { from, to, tz, bucketKey });
  const base = baseline(store.buckets ?? {}, { now, tz, bucketKey });

  // Today so far, which is what an anomaly is judged on — and how much of
  // today has actually happened, so the baseline is scaled to match.
  //
  // Elapsed hours come from the CLOCK, not from how many buckets exist. An
  // outage produces no buckets at all, and counting them would have shrunk
  // the expectation to match the outage — the one case the comparison exists
  // to catch.
  const nowKey = bucketKey(to.toISOString(), tz) ?? '';
  const hoursElapsed = Math.min(24, Number(nowKey.slice(11, 13)) + 1 || 1);
  const today = windowStats(store, {
    from: new Date(to.getTime() - hoursElapsed * 3600000), to, tz, bucketKey,
  });
  const anomalyList = anomalies(today, base, {
    dropPct: workflow.anomalyDropPct ?? 40,
    partialDay: Math.min(Math.max(hoursElapsed, 1) / 24, 1),
  });

  return {
    workflow,
    store,
    range: r,
    from,
    to,
    stats,
    today,
    baseline: base,
    anomalies: anomalyList,
    health: health(workflow, { stats, base, anomalyList, now, allRows: store.rows ?? [] }),
    sync: store.sync ?? {},
  };
}

/** Estate-wide roll-up across every analysed workflow. */
export function overview(analysed) {
  const totals = {
    workflows: analysed.length,
    executions: 0, successful: 0, failed: 0, items: 0, bytes: 0,
    msSum: 0, counted: 0, anomalous: 0, stale: 0,
    byHealth: Object.fromEntries(HEALTH.map((h) => [h, 0])),
  };
  for (const a of analysed) {
    totals.executions += a.stats.executions;
    totals.successful += a.stats.successful;
    totals.failed += a.stats.failed;
    totals.items += a.stats.items;
    totals.bytes += a.stats.bytes;
    if (a.stats.avgMs) { totals.msSum += a.stats.avgMs * a.stats.executions; totals.counted += a.stats.executions; }
    if (a.anomalies.length) totals.anomalous += 1;
    if (a.health.state === 'STALE') totals.stale += 1;
    totals.byHealth[a.health.state] = (totals.byHealth[a.health.state] ?? 0) + 1;
  }
  totals.failureRate = totals.executions > 0 ? (totals.failed / totals.executions) * 100 : null;
  totals.avgMs = totals.counted > 0 ? Math.round(totals.msSum / totals.counted) : null;
  return totals;
}

/** The same roll-up, split by the Estate project each workflow belongs to. */
export function byProject(analysed) {
  const out = new Map();
  for (const a of analysed) {
    const id = a.workflow.project ?? null;
    const key = id ?? '—';
    const row = out.get(key) ?? { project: id, label: id ?? 'No project', executions: 0, failed: 0, items: 0, workflows: 0 };
    row.executions += a.stats.executions;
    row.failed += a.stats.failed;
    row.items += a.stats.items;
    row.workflows += 1;
    out.set(key, row);
  }
  return [...out.values()].sort((a, b) => b.items - a.items || b.executions - a.executions);
}
