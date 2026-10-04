/**
 * The Workflow analytics section, and the analytics half of each workflow's
 * detail page.
 *
 * Built to the same rules as the rest of the page: the tokens in DESIGN.md, no
 * chart library, every chart twinned by a table so no value is reachable only
 * by hovering, and no figure printed without a note saying where it came from.
 *
 * ONE departure, deliberately. Every other chart on this page is static SVG
 * emitted at build time. The timeline charts here are painted in the browser
 * from an inlined series, because the brief needs seven time ranges plus a
 * custom one and pre-rendering fourteen SVGs per workflow would add megabytes
 * to a file whose portability is the point. The painter is thirty lines of
 * <rect> arithmetic using the same CSS custom properties, so it repaints
 * correctly on a theme switch and adds no dependency. The table-view twin is
 * still rendered server-side, which is what keeps every number reachable with
 * JavaScript off and on paper.
 */

import { escapeHtml } from './markdown.js';
import { funnelChart, statTile } from './charts.js';
import { RANGES, formatMins } from '../n8n/analytics.js';

const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const pct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');

/** ms as the shortest honest reading. 840ms, 3.4s, 2m 10s. */
export function ms(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  const m = Math.floor(value / 60000);
  return `${m}m ${Math.round((value % 60000) / 1000)}s`;
}

export function bytes(value) {
  if (!Number.isFinite(value) || value === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Health state to the tone classes the rest of the page already uses. */
const TONE = {
  HEALTHY: 'tone-ok',
  WARNING: 'tone-high',
  STALE: 'tone-high',
  'NO DATA': 'tone-high',
  CRITICAL: 'tone-critical',
  UNKNOWN: 'tone-unknown',
};
const DOT = {
  HEALTHY: 'live', WARNING: 'partial', STALE: 'partial', 'NO DATA': 'partial', CRITICAL: 'broken', UNKNOWN: 'idle',
};

export const healthBadge = (state) => `<span class="sev ${TONE[state] ?? 'tone-unknown'}">${escapeHtml(state)}</span>`;

function tableView(headers, rows, { label = 'Table view' } = {}) {
  return `<details class="table-view">
    <summary>${escapeHtml(label)}</summary>
    <div class="table-wrap"><table>
      <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td data-label="${escapeHtml(headers[i] ?? '')}"${i > 0 ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
  </details>`;
}

const legend = (items) => `<div class="legend">${items.map((i) => `<span class="legend-item">
  <span class="legend-swatch" style="background:${i.color}"></span>${escapeHtml(i.label)}
</span>`).join('')}</div>`;

/* ------------------------------------------------- the inlined series */

/**
 * The series the browser paints from, as compactly as it can be written.
 *
 * Points are contiguous from `k0`, so only the first key is stored; an empty
 * bucket is the number 0 rather than six zeroes, which is most of them on most
 * workflows. Hourly covers the sub-week ranges, daily the rest — a 90-day
 * hourly series would be 2,160 points per workflow for a chart that can only
 * show 90 bars.
 */
export function packSeries(points) {
  return points.map((p) => (p.n === 0 && p.items === 0
    ? 0
    : [p.n, p.ok, p.fail, p.items, p.msSum, p.covered]));
}

export function seriesPayload(analysed, { hourly, daily }) {
  const out = {};
  for (const a of analysed) {
    const h = hourly.get(a.workflow.key) ?? [];
    const d = daily.get(a.workflow.key) ?? [];
    out[a.workflow.key] = {
      name: a.workflow.name ?? a.workflow.id,
      id: a.workflow.id,
      k0h: h[0]?.key ?? null,
      h: packSeries(h),
      k0d: d[0]?.key ?? null,
      d: packSeries(d),
    };
  }
  return out;
}

/* ---------------------------------------------------------- range chips */

function rangeChips(id, { active = '24h' } = {}) {
  return `<div class="filter-row wf-ranges" data-chart-group="${escapeHtml(id)}">
    ${RANGES.map((r) => `<button class="chip" type="button" data-range="${r.id}" aria-pressed="${r.id === active}">${escapeHtml(r.label)}</button>`).join('')}
    <label class="wf-custom">
      <span class="faint">from</span>
      <input type="date" data-custom="from" aria-label="Custom range start">
      <span class="faint">to</span>
      <input type="date" data-custom="to" aria-label="Custom range end">
    </label>
  </div>`;
}

/**
 * A chart the client paints. The <svg> is empty on arrival and the table below
 * it is not, which is what keeps the numbers readable with no JavaScript.
 */
function paintedChart({
  id, title, note, measure, workflows, stacked = false, height = 170,
}) {
  return `<figure class="chart chart--painted" id="${escapeHtml(id)}">
    <figcaption>${escapeHtml(title)}</figcaption>
    ${stacked ? legend([{ label: 'Successful', color: 'var(--s1)' }, { label: 'Failed', color: 'var(--critical)' }]) : ''}
    <svg class="wf-plot" viewBox="0 0 560 ${height}" role="img" aria-label="${escapeHtml(title)}"
         preserveAspectRatio="none"
         data-measure="${escapeHtml(measure)}"${stacked ? ' data-stacked="1"' : ''}
         data-workflows="${escapeHtml(workflows.join(','))}"></svg>
    <p class="chart-note" data-plot-caption>${escapeHtml(note)}</p>
  </figure>`;
}

/* ----------------------------------------------------------- KPI tiles */

/**
 * The first question the dashboard answers: is everything healthy. Counts,
 * never a single green dot — "15 healthy, 2 warning, 1 critical" is actionable
 * and "mostly fine" is not.
 */
export function analyticsTiles(totals, { range, syncState }) {
  const h = totals.byHealth;
  const attention = (h.CRITICAL ?? 0) + (h.WARNING ?? 0) + (h.STALE ?? 0) + (h['NO DATA'] ?? 0);

  return `${collectorStrip(syncState)}
  <div class="tiles">
    ${statTile({
    value: `${h.HEALTHY ?? 0}/${totals.workflows}`,
    label: 'Healthy',
    note: attention ? `${attention} need attention` : 'nothing flagged',
    state: (h.CRITICAL ?? 0) > 0 ? 'critical' : (attention > 0 ? 'warning' : 'good'),
  })}
    ${statTile({ value: fmt(totals.executions), label: 'Executions', note: `in the last ${range.label}` })}
    ${statTile({
    value: fmt(totals.failed),
    label: 'Failed',
    note: totals.failureRate === null ? 'no executions' : `${pct(totals.failureRate)} of all runs`,
    state: totals.failed > 0 ? ((totals.failureRate ?? 0) > 10 ? 'critical' : 'warning') : 'good',
  })}
    ${statTile({
    value: fmt(totals.items),
    label: 'Items processed',
    note: totals.items === 0 && totals.executions > 0 ? 'no node data collected yet' : 'summed across every node peak',
  })}
    ${statTile({ value: ms(totals.avgMs), label: 'Average runtime', note: 'execution-weighted mean' })}
    ${statTile({
    value: String(totals.anomalous),
    label: 'Outside normal',
    note: totals.stale ? `${totals.stale} stale` : 'against their own baselines',
    state: totals.anomalous > 0 ? 'warning' : 'good',
  })}
  </div>`;
}

/**
 * How fresh everything below it is, read BEFORE the numbers it qualifies.
 *
 * This was a seventh KPI tile, which was wrong twice over: it orphaned onto a
 * row of its own in a six-column grid, and it is not a KPI. Every figure in
 * this section is only as true as the last successful collection, so that
 * sentence belongs above them, not as a seventh peer among them.
 *
 * It states the instances by name. With two n8n installations, "1 of 2
 * unreachable" is a different morning from "all good", and the one that is
 * down is the one you need named.
 */
function collectorStrip(syncState) {
  if (!syncState?.lastRunAt) {
    return `<div class="freshness freshness--bad">
      <span class="dot dot--broken"></span>
      <strong>No collection has completed here.</strong>
      <span>Every figure below is empty rather than good. Run <code>npm run wf-sync</code>, or
      <a href="/admin">collect from the admin panel</a>.</span>
    </div>`;
  }

  const ageMin = Math.floor((Date.now() - Date.parse(syncState.lastRunAt)) / 60000);
  const instances = Object.entries(syncState.instances ?? {});
  const down = instances.filter(([, i]) => !i.ok);
  // The timer runs every six hours, so eight is already a missed pass.
  const stale = ageMin > 480;
  const tone = down.length ? 'bad' : (stale ? 'warn' : 'ok');

  return `<div class="freshness freshness--${tone}">
    <span class="dot dot--${down.length ? 'broken' : (stale ? 'partial' : 'live')}"></span>
    <strong>Collected ${escapeHtml(formatMins(ageMin))} ago</strong>
    <span>
      ${syncState.synced}/${syncState.workflows} workflows
      · ${instances.length} n8n instance${instances.length === 1 ? '' : 's'}
      ${down.length
    ? `· <strong class="freshness-bad">${down.map(([id]) => escapeHtml(id)).join(', ')} unreachable</strong>`
    : '· all reachable'}
      · ${fmt(syncState.apiMs)} ms in n8n
    </span>
    ${stale ? '<span class="freshness-bad">That is more than a scheduled pass ago — these numbers predate it.</span>' : ''}
  </div>`;
}

/* ------------------------------------------------- cross-workflow table */

/**
 * Every monitored workflow in one sortable table. The column order is the
 * order the questions get asked: what is it, is it alright, when did it last
 * run, how much did it do, how often does it break, how long does it take.
 */
export function crossWorkflowTable(analysed, { linkWorkflow, linkProject, range }) {
  if (!analysed.length) {
    return `<div class="changes"><div class="empty">
      No workflows are registered for monitoring yet. The workflow inventory above lists every workflow that
      <em>exists</em>; this section is about what they actually <em>do</em>, which needs the n8n API rather than a
      dump. Register one with <code>npm run wf-add -- &lt;n8n workflow URL&gt;</code>, set
      <code>$N8N_API_KEY_MAIN</code> on srv1340120, and run <code>npm run wf-sync</code>.
    </div></div>`;
  }

  const sorted = [...analysed].sort((a, b) => {
    const rank = { CRITICAL: 0, STALE: 1, 'NO DATA': 2, WARNING: 3, UNKNOWN: 4, HEALTHY: 5 };
    return (rank[a.health.state] ?? 9) - (rank[b.health.state] ?? 9)
      || b.stats.items - a.stats.items
      || String(a.workflow.name).localeCompare(String(b.workflow.name));
  });

  return `<div class="table-wrap wf-table-wrap"><table class="wf-table" id="wf-cross-table">
    <thead><tr>
      <th data-sort="name">Workflow</th>
      <th data-sort="project">Project</th>
      <th data-sort="health">Health</th>
      <th data-sort="last" class="num">Last run</th>
      <th data-sort="runs" class="num">Executions</th>
      <th data-sort="items" class="num">Items</th>
      <th data-sort="fail" class="num">Failure %</th>
      <th data-sort="ms" class="num">Avg runtime</th>
    </tr></thead>
    <tbody>${sorted.map((a) => {
    const w = a.workflow;
    const s = a.stats;
    return `<tr class="searchable" data-search="${escapeHtml(`${w.name} ${w.id} ${w.project ?? ''} ${w.instance} ${a.health.state}`.toLowerCase())}"
        data-name="${escapeHtml(String(w.name ?? w.id).toLowerCase())}"
        data-project="${escapeHtml(String(w.project ?? '~').toLowerCase())}"
        data-health="${escapeHtml(String({ CRITICAL: 0, STALE: 1, 'NO DATA': 2, WARNING: 3, UNKNOWN: 4, HEALTHY: 5 }[a.health.state] ?? 9))}"
        data-health-state="${escapeHtml(a.health.state)}"
        data-last="${escapeHtml(String(a.health.sinceMin ?? 999999))}"
        data-runs="${s.executions}" data-items="${s.items}"
        data-fail="${s.failureRate ?? -1}" data-ms="${s.avgMs ?? -1}"
        data-instance="${escapeHtml(w.instance)}"
        data-anomaly="${a.anomalies.length ? 1 : 0}" data-failing="${s.failed > 0 ? 1 : 0}">
      <td data-label="Workflow"><span class="dot dot--${DOT[a.health.state]}"></span> ${linkWorkflow(w.id, w.name ?? w.id)}</td>
      <td data-label="Project">${w.project ? linkProject(w.project) : '<span class="faint">unclaimed</span>'}</td>
      <td data-label="Health">${healthBadge(a.health.state)}</td>
      <td data-label="Last run" class="num">${a.health.sinceMin === null ? '<span class="faint">never</span>' : `${escapeHtml(formatMins(a.health.sinceMin))} ago`}</td>
      <td data-label="Executions" class="num">${fmt(s.executions)}</td>
      <td data-label="Items" class="num">${s.itemsCovered === 0 && s.executions > 0 ? '<span class="faint">no node data</span>' : fmt(s.items)}</td>
      <td data-label="Failure %" class="num">${s.failureRate === null ? '—' : pct(s.failureRate)}</td>
      <td data-label="Avg runtime" class="num">${ms(s.avgMs)}</td>
    </tr>`;
  }).join('')}</tbody>
  </table></div>
  <div class="empty" id="wf-filter-empty" hidden></div>
  <p class="chart-note">Over the last ${escapeHtml(range.label)}. Click a column heading to sort
  <span id="wf-filter-count" class="wf-filter-count"></span></p>`;
}

/* ------------------------------------------------------------ rank bars */

/**
 * One measure, ranked. Emphasis rather than eight hues: this is "which of
 * these is biggest", not "here are nine equally interesting categories", so
 * every bar is the accent and the ordering carries the meaning.
 */
export function rankBars(rows, {
  title, id, unit = '', max: maxRows = 10, format = fmt, note = null, headers = ['What', 'Value'],
}) {
  const live = rows.filter((r) => Number.isFinite(r.value) && r.value > 0).slice(0, maxRows);
  if (!live.length) {
    return `<figure class="chart" id="${escapeHtml(id)}">
      <figcaption>${escapeHtml(title)}</figcaption>
      <div class="empty">Nothing to rank yet — no workflow has reported a non-zero ${escapeHtml(unit || 'value')} in this window.</div>
    </figure>`;
  }

  const max = Math.max(...live.map((r) => r.value));
  const rowH = 30;
  const barH = 13;
  const labelW = 150;
  const width = 560;
  const trackW = width - labelW - 86;

  return `<figure class="chart" id="${escapeHtml(id)}">
    <figcaption>${escapeHtml(title)}</figcaption>
    <svg viewBox="0 0 ${width} ${live.length * rowH + 6}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="xMinYMin meet">
      ${live.map((r, i) => {
    const y = i * rowH + 8;
    const w = (r.value / max) * trackW;
    return `<g>
        <text class="axis-label" x="${labelW - 12}" y="${y + barH - 2}" text-anchor="end">${escapeHtml(String(r.label).slice(0, 26))}</text>
        <rect class="track" x="${labelW}" y="${y}" width="${trackW}" height="${barH}" rx="4" />
        <rect class="bar" x="${labelW}" y="${y}" width="${Math.max(1, w).toFixed(1)}" height="${barH}" rx="4" fill="var(--s1)">
          <title>${escapeHtml(String(r.label))}: ${escapeHtml(format(r.value))}${unit ? ` ${escapeHtml(unit)}` : ''}</title>
        </rect>
        <text class="value-label" x="${(labelW + w + 10).toFixed(1)}" y="${y + barH - 2}">${escapeHtml(format(r.value))}</text>
      </g>`;
  }).join('')}
    </svg>
    ${note ? `<p class="chart-note">${escapeHtml(note)}</p>` : ''}
    ${tableView(headers, live.map((r) => [escapeHtml(String(r.label)), escapeHtml(format(r.value))]))}
  </figure>`;
}

/* --------------------------------------------------------- distribution */

/**
 * Runtime as four readings, not one.
 *
 * An average hides the tail completely: a workflow that normally takes two
 * seconds and occasionally takes four minutes has a perfectly reassuring mean.
 * The p95 is the number that tells you whether anybody is waiting.
 */
export function runtimeChart(stats, { id = 'wf-runtime', title = 'Execution duration', note = null } = {}) {
  const readings = [
    { label: 'Average', value: stats.avgMs },
    { label: 'Median', value: stats.medianMs },
    { label: 'p95', value: stats.p95Ms },
    { label: 'Maximum', value: stats.maxMs },
  ].filter((r) => Number.isFinite(r.value));

  if (!readings.length) {
    return `<figure class="chart" id="${escapeHtml(id)}">
      <figcaption>${escapeHtml(title)}</figcaption>
      <div class="empty">No completed execution in this window recorded both a start and a stop time, so there is
      no duration to report.</div>
    </figure>`;
  }

  const unavailable = !stats.runtimeFromRows && stats.executions > 0;
  const max = Math.max(...readings.map((r) => r.value));
  const rowH = 30;
  const barH = 13;
  const labelW = 90;
  const width = 560;
  const trackW = width - labelW - 96;

  return `<figure class="chart" id="${escapeHtml(id)}">
    <figcaption>${escapeHtml(title)}</figcaption>
    <svg viewBox="0 0 ${width} ${readings.length * rowH + 6}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="xMinYMin meet">
      ${readings.map((r, i) => {
    const y = i * rowH + 8;
    const w = (r.value / max) * trackW;
    // The ordinal ramp, because these ARE ordered stages of the same measure.
    const color = `var(--ord-${Math.min(3, i + 1)})`;
    return `<g>
        <text class="axis-label" x="${labelW - 12}" y="${y + barH - 2}" text-anchor="end">${escapeHtml(r.label)}</text>
        <rect class="track" x="${labelW}" y="${y}" width="${trackW}" height="${barH}" rx="4" />
        <rect class="bar" x="${labelW}" y="${y}" width="${Math.max(1, w).toFixed(1)}" height="${barH}" rx="4" fill="${color}">
          <title>${escapeHtml(r.label)}: ${escapeHtml(ms(r.value))}</title>
        </rect>
        <text class="value-label" x="${(labelW + w + 10).toFixed(1)}" y="${y + barH - 2}">${escapeHtml(ms(r.value))}</text>
      </g>`;
  }).join('')}
    </svg>
    ${note ? `<p class="chart-note">${escapeHtml(note)}</p>`
    : (unavailable ? `<p class="chart-note">Median and p95 need the individual executions, and this window reaches past
      the ${escapeHtml(fmt(stats.rows.length))} rows still held for it. The mean and the maximum come from the hourly
      aggregate and are exact.</p>` : '')}
    ${tableView(['Reading', 'Duration'], readings.map((r) => [escapeHtml(r.label), escapeHtml(ms(r.value))]))}
  </figure>`;
}

/* ------------------------------------------------------------- anomalies */

export function anomalyPanel(analysed) {
  const flagged = analysed.filter((a) => a.anomalies.length);
  if (!flagged.length) {
    const withBaseline = analysed.filter((a) => a.baseline.ok).length;
    return `<div class="changes"><div class="empty">
      ${withBaseline
    ? `Nothing outside its normal range. ${withBaseline} of ${analysed.length} workflows have enough history for a
       baseline; the rest need seven complete days before anything can be called abnormal.`
    : `No baselines yet. An anomaly is a comparison against this workflow's own history, and none of these has
       seven complete days of it — so nothing here can honestly be called abnormal, including the things that are.`}
    </div></div>`;
  }

  return flagged.map((a) => `<div class="issue issue--${a.anomalies[0].severity === 'high' ? 'high' : 'medium'}">
    <div class="issue-head">
      <span class="sev sev--${a.anomalies[0].severity}">${escapeHtml(a.anomalies[0].severity)}</span>
      <span class="issue-title">${escapeHtml(a.workflow.name ?? a.workflow.id)}</span>
    </div>
    <div class="issue-body">
      <ul>${a.anomalies.map((an) => `<li><strong>${escapeHtml(an.detail)}</strong>
        <span class="faint">— ${escapeHtml(fmt(an.observed))} today against a normal ${escapeHtml(fmt(an.expected))},
        modified z-score ${escapeHtml(String(an.z))}</span></li>`).join('')}</ul>
      <p class="issue-evidence">Baseline: median and median-absolute-deviation over the last
      ${a.baseline.days} complete days, excluding today. Flagged past a z-score of 3.5 <em>and</em>
      ${a.workflow.anomalyDropPct}%, so a statistically real move from eleven items to seven does not mail anybody.</p>
    </div>
  </div>`).join('');
}

/* --------------------------------------------------------- node funnel */

/**
 * Where the data went, stage by stage.
 *
 * Reuses the funnel the Analysis section already draws, because it is the same
 * question — ordered stages with a collapse somewhere — and a second funnel
 * with its own visual language would be a worse answer to it.
 */
export function funnelPanel(funnel, { title }) {
  if (!funnel) {
    return `<div class="empty">No node-level data has been collected for this workflow yet. Item counts come from
    <code>data.resultData.runData</code>, which n8n only returns on a single-execution request — the collector
    fetches those on a budget, newest and failed first, so a workflow collected for the first time may not have any
    until the next pass. If n8n has already pruned an execution's data, it never will.</div>`;
  }

  const stages = funnel.stages.map((s) => ({
    label: s.node,
    value: s.items,
    note: s.dropped > 0 ? `${fmt(s.dropped)} fewer than the stage before` : undefined,
    broken: s.items === 0,
  }));

  return `${funnelChart(stages, { title, id: `funnel-${Math.random().toString(36).slice(2, 8)}` })}
  <div class="table-wrap"><table>
    <thead><tr><th>Node</th><th class="num">Items out</th><th class="num">Dropped</th><th class="num">Time</th><th class="num">Runs</th></tr></thead>
    <tbody>${funnel.stages.map((s) => `<tr>
      <td data-label="Node">${escapeHtml(s.node)}</td>
      <td data-label="Items out" class="num">${fmt(s.items)}</td>
      <td data-label="Dropped" class="num">${s.dropped === null ? '—' : (s.dropped > 0 ? fmt(s.dropped) : `+${fmt(-s.dropped)}`)}</td>
      <td data-label="Time" class="num">${ms(s.ms / Math.max(s.runs, 1))}</td>
      <td data-label="Runs" class="num">${s.runs}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="chart-note">Summed across the newest ${funnel.executions} successful execution${funnel.executions === 1 ? '' : 's'}
  that still carry node detail. A negative drop is a gain — a split or an item-per-row node produces more than it
  received, which is not a loss.</p>`;
}

/* ------------------------------------------------------- stage volume */

/**
 * How much data reached each named stage, hour by hour.
 *
 * The funnel above answers "where does my data disappear". This answers the
 * other half — "when did it go, and how much got to the far end" — because a
 * drop that only happens between 02:00 and 04:00 averages into a perfectly
 * healthy daily total and is invisible in any summary.
 *
 * Grouped bars rather than stacked: these stages are not parts of a whole,
 * they are the same records counted again at each stop, so stacking them would
 * draw a total that does not exist. Categorical colour in registered order,
 * capped at the six validated hues with the tail folded into "other".
 */
export function stageChart(stage, { id, title, note = null }) {
  if (!stage || !stage.stages.length) {
    return `<div class="empty">No checkpoints are registered for this workflow, so there is nothing to count per
    stage. Add the n8n node names you care about — <code>npm run wf-add -- &lt;url&gt; --checkpoint "Fetch from Cratio"
    --checkpoint "Meta CAPI"</code> — and the next collection will start counting each one separately, by hour.</div>`;
  }

  const shown = stage.stages.slice(0, 6);
  const colors = shown.map((_, i) => `var(--s${i + 1})`);
  const points = stage.points.slice(-24);
  const max = Math.max(1, ...points.flatMap((p) => shown.map((s) => p.byStage[s] ?? 0)));

  const width = 560;
  const height = 190;
  const padL = 48;
  const padB = 22;
  const padT = 8;
  const plotH = height - padT - padB;
  const slot = (width - padL) / Math.max(points.length, 1);
  const bw = Math.max(0.8, (slot - 2) / shown.length);

  const bars = points.map((p, i) => shown.map((s, si) => {
    const v = p.byStage[s] ?? 0;
    if (v <= 0) return '';
    const h = (v / max) * plotH;
    const x = padL + i * slot + si * bw;
    return `<rect class="bar" x="${x.toFixed(1)}" y="${(padT + plotH - h).toFixed(1)}"
      width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${colors[si]}"
      ><title>${escapeHtml(p.key)} — ${escapeHtml(s)}: ${fmt(v)} items</title></rect>`;
  }).join('')).join('');

  const ticks = [0, 0.5, 1].map((f) => {
    const y = padT + plotH * (1 - f);
    return `<line class="wf-grid" x1="${padL}" x2="${width}" y1="${y}" y2="${y}" />
      <text class="axis-label" x="${padL - 8}" y="${y + 3}" text-anchor="end">${max * f >= 10000 ? `${Math.round((max * f) / 1000)}k` : Math.round(max * f)}</text>`;
  }).join('');

  const xLabels = [0, Math.floor(points.length / 2), points.length - 1]
    .filter((i) => points[i])
    .map((i, j) => `<text class="axis-label" x="${padL + i * slot + (j === 2 ? slot : 0)}" y="${height - 6}"
      text-anchor="${j === 0 ? 'start' : (j === 2 ? 'end' : 'middle')}">${escapeHtml(points[i].key.length > 10 ? `${points[i].key.slice(11, 13)}:00` : points[i].key.slice(5))}</text>`).join('');

  // Drop between consecutive registered stages, over the whole window. This is
  // the number the question is really after.
  const losses = shown.slice(1).map((s, i) => {
    const before = stage.totals[shown[i]] ?? 0;
    const after = stage.totals[s] ?? 0;
    return { from: shown[i], to: s, before, after, dropped: before - after };
  });

  return `<figure class="chart" id="${escapeHtml(id)}">
    <figcaption>${escapeHtml(title)}</figcaption>
    ${legend(shown.map((s, i) => ({ label: s, color: colors[i] })))}
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="none"
         style="aspect-ratio:${width} / ${height};max-width:none">
      ${ticks}${bars}${xLabels}
    </svg>
    ${stage.stages.length > 6 ? `<p class="chart-note">Showing the six busiest of ${stage.stages.length} checkpoints;
      the table below carries them all.</p>` : ''}
    ${losses.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Between</th><th class="num">In</th><th class="num">Out</th><th class="num">Lost</th><th class="num">Reached</th></tr></thead>
      <tbody>${losses.map((l) => `<tr>
        <td data-label="Between">${escapeHtml(l.from)} <span class="faint">&rarr;</span> ${escapeHtml(l.to)}</td>
        <td data-label="In" class="num">${fmt(l.before)}</td>
        <td data-label="Out" class="num">${fmt(l.after)}</td>
        <td data-label="Lost" class="num">${l.dropped > 0 ? fmt(l.dropped) : `+${fmt(-l.dropped)}`}</td>
        <td data-label="Reached" class="num">${l.before > 0 ? `${((l.after / l.before) * 100).toFixed(1)}%` : '—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : ''}
    ${note ? `<p class="chart-note">${escapeHtml(note)}</p>` : ''}
    ${tableView(['Bucket', ...stage.stages].map(String),
    points.slice().reverse().map((p) => [
      escapeHtml(p.key.length > 10 ? `${p.key.replace('T', ' ')}:00` : p.key),
      ...stage.stages.map((s) => fmt(p.byStage[s] ?? 0)),
    ]), { label: 'Every stage, every bucket' })}
  </figure>`;
}

/* ------------------------------------------------------- dimensions */

/**
 * What was in the items, where a dimension has been configured.
 *
 * Two shapes, because they answer two different questions. A `group`
 * dimension is a breakdown — which upload bucket, which lead source, which
 * intent — and gets ranked bars. A `distinct` dimension is a population
 * count — how many people did we actually talk to — and gets a number, because
 * there is nothing to list: only salted pseudonyms are held, deliberately.
 */
export function dimensionPanel(dimensions, { title = 'What went through' } = {}) {
  const entries = Object.entries(dimensions ?? {});
  if (!entries.length) {
    return `<div class="empty">No dimensions are configured for this workflow, so nothing is counted beyond how many
    items moved. A dimension names one field on one node — the upload bucket, the lead source, the contact — and
    counts it. Find the fields it actually emits with <code>npm run wf-fields -- &lt;workflow id&gt;</code>, which
    prints names and shape and never a value.</div>`;
  }

  return entries.map(([label, got]) => {
    if (got.refused) {
      return `<div class="dim">
        <h4 class="dim-title">${escapeHtml(label)}</h4>
        <p class="dim-refused">${escapeHtml(got.refused)}</p>
      </div>`;
    }

    if (Number.isFinite(got.distinct) || Number.isFinite(got.peakOnly)) {
      // Two different claims, and they must not be made to look alike.
      // `distinct` is a true unique count across the window. `peakOnly` is the
      // busiest single execution, reported when the window held too many
      // pseudonyms to union — which is exact, and is not a window total.
      const unique = Number.isFinite(got.distinct);
      return `<div class="dim">
        <h4 class="dim-title">${escapeHtml(label)}</h4>
        <div class="dim-big">${fmt(unique ? got.distinct : got.peakOnly)}<span class="dim-unit">${
  unique ? 'distinct in this window' : 'in the busiest single run'}</span></div>
        <p class="dim-note">
          ${unique
    ? `Across ${fmt(got.runs)} execution${got.runs === 1 ? '' : 's'} and ${fmt(got.total)} items${
      got.repeatSeen ? `, ${fmt(got.repeatSeen)} seen more than once within a run` : ''}.`
    : `Too many to count uniquely across the window — holding ${fmt(got.total)} pseudonyms per pass is not worth the
       bytes, so this is the exact figure for one run rather than a floor dressed up as a total.`}
          Counted by salted pseudonym: enough to tell a returning one from a new one, not enough to say who.
          No identifier is stored.
        </p>
      </div>`;
    }

    const values = Object.entries(got.values ?? {}).sort((a, b) => b[1] - a[1]);
    if (!values.length) return '';
    const max = Math.max(...values.map(([, n]) => n));

    return `<div class="dim">
      <h4 class="dim-title">${escapeHtml(label)}
        <span class="dim-count">${values.length} value${values.length === 1 ? '' : 's'} · ${fmt(got.total)} items</span>
      </h4>
      <div class="dim-bars">${values.slice(0, 12).map(([value, n]) => `<div class="dim-row">
        <span class="dim-label" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
        <span class="dim-track"><span class="dim-fill" style="width:${((n / max) * 100).toFixed(1)}%"></span></span>
        <span class="dim-n">${fmt(n)}</span>
        <span class="dim-pct">${((n / Math.max(got.total, 1)) * 100).toFixed(0)}%</span>
      </div>`).join('')}</div>
      ${got.missing ? `<p class="dim-note">${fmt(got.missing)} item${got.missing === 1 ? '' : 's'} had no value for
        this field, or one too long to be a label.</p>` : ''}
    </div>`;
  }).join('');
}

/* ---------------------------------------------- per-workflow analytics */

/**
 * How many execution rows are rendered into the page, per workflow.
 *
 * Was 60, which across thirteen workflows was 365 KB of the 871 KB page — 42%
 * of the bytes, for rows nobody had scrolled to. Twenty is a screenful, which
 * is what the table is for.
 *
 * The CSV export does NOT read this table. It reads the packed island below,
 * which carries every held row at about a tenth of the bytes an HTML row
 * costs, so showing less on screen does not take the full history away from
 * the person who asked for it.
 */
const EXEC_ROWS = 20;

const EXEC_COLS = ['Started', 'Execution', 'Status', 'Duration (ms)', 'Items in', 'Peak items', 'Items out', 'Bytes', 'Mode', 'Failed node', 'Error'];

/** Every held row, as arrays. One tenth the bytes of the equivalent markup. */
export function execPayload(analysed) {
  const out = {};
  for (const a of analysed) {
    out[a.workflow.key] = {
      name: a.workflow.name ?? a.workflow.id,
      cols: EXEC_COLS,
      rows: (a.store.rows ?? []).map((r) => [
        r.startedAt ?? '', r.id, r.status, r.ms ?? '',
        r.inputItems ?? '', Number.isFinite(r.items) ? r.items : '', r.outputItems ?? '',
        r.bytes ?? '', r.mode ?? '', r.failedNode ?? '', r.error ?? '',
      ]),
    };
  }
  return out;
}

/**
 * The analytics board for one workflow, appended to the page it already has.
 *
 * Extends the existing workflow panel rather than inventing a second one:
 * identity, ownership and state history stay where they were, and this is the
 * telemetry underneath them.
 */
export function workflowAnalyticsBoard(a, { startNum = 1, executionUrl }) {
  const { workflow: w, stats, health: h } = a;
  const funnel = a.funnel ?? null;
  let num = startNum;
  const n = () => num++;

  const failures = (a.store.rows ?? []).filter((r) => r.status === 'error').slice(0, 12);
  const recent = (a.store.rows ?? []).slice(0, EXEC_ROWS);

  return `
    <section class="board-panel board-panel--wide">
      <h2 class="board-title"><span class="board-num">${n()}</span>Health and volume</h2>
      <div class="board-content">
        <div class="tags" style="margin:0 0 12px">
          ${healthBadge(h.state)}
          <span class="pill">${escapeHtml(a.range.label)} window</span>
          ${w.expectedIntervalMin ? `<span class="pill">expected every ${escapeHtml(formatMins(w.expectedIntervalMin))}</span>` : '<span class="pill">no schedule declared</span>'}
          ${w.minimumItems > 0 ? `<span class="pill">min ${w.minimumItems} item${w.minimumItems === 1 ? '' : 's'}</span>` : ''}
        </div>
        <ul class="wf-reasons">${h.reasons.map((r) => `<li><span class="dot dot--${DOT[r.state]}"></span> ${escapeHtml(r.why)}</li>`).join('')}</ul>
        <dl class="kv">
          <dt>Executions</dt><dd>${fmt(stats.executions)} · ${fmt(stats.successful)} succeeded · ${fmt(stats.failed)} failed</dd>
          <dt>Failure rate</dt><dd>${stats.failureRate === null ? '—' : pct(stats.failureRate)}</dd>
          <dt>Items processed</dt><dd>${stats.itemsCovered === 0
    ? 'no node data collected in this window'
    : `${fmt(stats.items)}${stats.itemsComplete ? '' : ` <span class="faint">on ${fmt(stats.itemsCovered)} of ${fmt(stats.executions)} executions</span>`}`}</dd>
          <dt>Items per run</dt><dd>${stats.itemsPerExecution === null ? '—' : fmt(stats.itemsPerExecution)}</dd>
          <dt>Throughput</dt><dd>${stats.throughput === null ? '—' : `${stats.throughput} items/min`}</dd>
          <dt>Payload</dt><dd>${bytes(stats.bytes)} <span class="faint">n8n jsonSizeBytes, every execution</span></dd>
          <dt>Last run</dt><dd>${stats.lastRun
    ? `${escapeHtml(String(stats.lastRun.at ?? '').replace('T', ' ').slice(0, 19))} UTC · ${escapeHtml(stats.lastRun.status)}`
    : '<span class="faint">none collected</span>'}</dd>
          <dt>Baseline</dt><dd>${a.baseline.ok
    ? `${a.baseline.days} complete days${a.baseline.items ? ` · normally ${fmt(a.baseline.items.median)} items/day (±${fmt(a.baseline.items.mad)})` : ' · no item history'}`
    : `<span class="faint">needs ${a.baseline.minDays} complete days, has ${a.baseline.days}</span>`}</dd>
        </dl>
      </div>
    </section>

    <section class="board-panel board-panel--flow">
      <h2 class="board-title"><span class="board-num">${n()}</span>Over time</h2>
      <div class="board-content">
        ${rangeChips(`wf-${w.key}`)}
        <div class="chart-grid">
          ${paintedChart({
    id: `plot-exec-${w.key}`,
    title: 'Executions, successful and failed',
    measure: 'executions',
    stacked: true,
    workflows: [w.key],
    note: 'Bars are executions started in each bucket.',
  })}
          ${paintedChart({
    id: `plot-items-${w.key}`,
    title: 'Items processed',
    measure: 'items',
    workflows: [w.key],
    note: 'Summed peak-node items per execution.',
  })}
        </div>
        ${tableView(['Hour', 'Executions', 'Failed', 'Items', 'Avg runtime'],
    stats.points.slice(-24).reverse().map((p) => [
      escapeHtml(p.key.replace('T', ' ') + ':00'),
      fmt(p.n), fmt(p.fail),
      p.covered ? fmt(p.items) : '—',
      p.n ? escapeHtml(ms(p.msSum / p.n)) : '—',
    ]), { label: 'Last 24 hours, hour by hour' })}
      </div>
    </section>

    <section class="board-panel">
      <h2 class="board-title"><span class="board-num">${n()}</span>Runtime</h2>
      <div class="board-content">${runtimeChart(stats, { id: `rt-${w.key}`, title: `Duration over ${a.range.label}` })}</div>
    </section>

    <section class="board-panel">
      <h2 class="board-title"><span class="board-num">${n()}</span>Failures</h2>
      <div class="board-content">
        ${failures.length ? `<div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Node</th><th>Error</th></tr></thead>
          <tbody>${failures.map((r) => `<tr>
            <td data-label="When" class="num">${executionUrl(w, r.id, String(r.startedAt ?? '').replace('T', ' ').slice(5, 16))}</td>
            <td data-label="Node">${r.failedNode ? escapeHtml(r.failedNode) : '<span class="faint">not recorded</span>'}</td>
            <td data-label="Error">${r.error ? escapeHtml(r.error) : '<span class="faint">no message</span>'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="chart-note">Newest first, out of the rows still held. Error text is redacted through the same table
        ingest uses — an n8n error quotes the request that failed, and that request carries keys.</p>`
    : '<div class="empty">No failed execution among the rows held for this workflow.</div>'}
      </div>
    </section>

    <section class="board-panel board-panel--flow">
      <h2 class="board-title"><span class="board-num">${n()}</span>Where the data goes</h2>
      <div class="board-content">${funnelPanel(funnel, { title: 'Items out of each node' })}</div>
    </section>

    <section class="board-panel board-panel--flow">
      <h2 class="board-title"><span class="board-num">${n()}</span>What went through</h2>
      <div class="board-content">
        <div class="dims">${dimensionPanel(a.dimensions)}</div>
      </div>
    </section>

    <section class="board-panel board-panel--flow">
      <h2 class="board-title"><span class="board-num">${n()}</span>How much reached each stage, and when</h2>
      <div class="board-content">
        ${stageChart(a.stages, {
    id: `stage-${w.key}`,
    title: w.checkpoints?.length
      ? `${w.checkpoints.join(' → ')}, by hour`
      : 'Items per stage, by hour',
    note: 'The funnel above sums over executions and cannot say when. This is the same data against the clock, so a'
      + ' drop that only happens overnight shows as a shape rather than averaging into a healthy daily total.'
      + ' Bars are grouped, not stacked: these are the same records counted again at each stop, so a stacked total'
      + ' would be a number that does not exist.',
  })}
      </div>
    </section>

    <section class="board-panel board-panel--flow">
      <h2 class="board-title"><span class="board-num">${n()}</span>Execution history</h2>
      <div class="board-content">
        <div class="filter-row" data-exec-filter="${escapeHtml(w.key)}">
          <button class="chip" type="button" data-status="all" aria-pressed="true">All</button>
          <button class="chip" type="button" data-status="error" aria-pressed="false">Failed</button>
          <button class="chip" type="button" data-status="success" aria-pressed="false">Successful</button>
          <button class="chip" type="button" data-csv="${escapeHtml(w.key)}">Export CSV</button>
        </div>
        ${recent.length ? `<div class="table-wrap"><table class="exec-table" data-exec="${escapeHtml(w.key)}">
          <thead><tr><th>Started</th><th>Execution</th><th>Status</th><th class="num">Duration</th><th class="num">Items in</th><th class="num">Peak</th><th class="num">Items out</th><th>Error</th></tr></thead>
          <tbody>${recent.map((r) => `<tr data-status="${escapeHtml(r.status)}">
            <td data-label="Started" class="num">${escapeHtml(String(r.startedAt ?? '').replace('T', ' ').slice(0, 19))}</td>
            <td data-label="Execution" class="num">${executionUrl(w, r.id, `#${r.id}`)}</td>
            <td data-label="Status"><span class="dot dot--${r.status === 'success' ? 'live' : (r.status === 'error' ? 'broken' : 'idle')}"></span> ${escapeHtml(r.status)}${r.retryOf ? ` <span class="faint">retry of ${escapeHtml(r.retryOf)}</span>` : ''}</td>
            <td data-label="Duration" class="num">${ms(r.ms)}</td>
            <td data-label="Items in" class="num">${Number.isFinite(r.inputItems) ? fmt(r.inputItems) : '—'}</td>
            <td data-label="Peak" class="num">${Number.isFinite(r.items) ? fmt(r.items) : `<span class="faint" title="${escapeHtml(r.dataWithheld ?? r.volumeSource ?? '')}">${escapeHtml(r.bytes ? bytes(r.bytes) : 'n/a')}</span>`}</td>
            <td data-label="Items out" class="num">${Number.isFinite(r.outputItems) ? fmt(r.outputItems) : '—'}</td>
            <td data-label="Error">${r.error ? escapeHtml(r.error.slice(0, 90)) : ''}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="chart-note">The newest <strong>${Math.min(EXEC_ROWS, recent.length)}</strong> of
        <strong>${fmt((a.store.rows ?? []).length)}</strong> rows held — <strong>Export CSV</strong> gives all of them,
        with the mode, payload size and failed node this table has no room for.
        "Peak" is the largest number of items any one node emitted, which is the volume figure the charts use;
        a greyed cell means n8n withheld or had already pruned that execution's node data, and the payload size is shown
        instead rather than an item count being guessed.</p>`
    : '<div class="empty">No executions collected yet.</div>'}
      </div>
    </section>`;
}

/* ------------------------------------------------------ collector panel */

export function collectorPanel(syncState, { linkServer }) {
  if (!syncState?.lastRunAt) {
    return `<div class="changes"><div class="empty">The collector has never run here. <code>npm run wf-sync</code>
    reads the n8n API and writes <code>data/runs/</code>; on srv1340120 the 6-hourly timer does it.</div></div>`;
  }

  const instances = Object.entries(syncState.instances ?? {});
  const failing = (syncState.perWorkflow ?? []).filter((w) => w.status === 'failed');

  return `<div class="board">
    <section class="board-panel">
      <h2 class="board-title"><span class="board-num">1</span>Last collection</h2>
      <div class="board-content"><dl class="kv">
        <dt>Ran at</dt><dd>${escapeHtml(syncState.lastRunAt.replace('T', ' ').slice(0, 19))} UTC</dd>
        <dt>Workflows</dt><dd>${syncState.synced} synced, ${syncState.failed} failed of ${syncState.workflows}</dd>
        <dt>New executions</dt><dd>${fmt(syncState.added)}</dd>
        <dt>With node data</dt><dd>${fmt(syncState.detailed)}</dd>
        <dt>Time in n8n</dt><dd>${syncState.apiMs} ms total, slowest workflow ${syncState.slowestMs} ms</dd>
        <dt>Bucketed in</dt><dd>${escapeHtml(syncState.tz ?? 'UTC')}</dd>
        <dt>Last error</dt><dd>${syncState.lastError ? escapeHtml(syncState.lastError) : '<span class="faint">none</span>'}</dd>
      </dl></div>
    </section>

    <section class="board-panel">
      <h2 class="board-title"><span class="board-num">2</span>n8n instances</h2>
      <div class="board-content">
        <div class="table-wrap"><table>
          <thead><tr><th>Instance</th><th>Reachable</th><th class="num">Latency</th><th>Server</th></tr></thead>
          <tbody>${instances.map(([id, i]) => `<tr>
            <td data-label="Instance">${escapeHtml(id)}<br><span class="faint">${escapeHtml(i.baseUrl)}</span></td>
            <td data-label="Reachable"><span class="dot dot--${i.ok ? 'live' : 'broken'}"></span> ${i.ok ? 'yes' : escapeHtml(String(i.error ?? 'no').slice(0, 70))}</td>
            <td data-label="Latency" class="num">${i.apiMs} ms</td>
            <td data-label="Server">${i.server ? linkServer(i.server) : '<span class="faint">—</span>'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="chart-note">Checked once per instance per pass, not once per workflow — thirteen workflows on a dead
        n8n are one outage, not thirteen reports of one.</p>
      </div>
    </section>

    ${failing.length || (syncState.registryErrors ?? []).length ? `<section class="board-panel board-panel--wide">
      <h2 class="board-title"><span class="board-num">3</span>What is not being collected</h2>
      <div class="board-content">
        ${(syncState.registryErrors ?? []).length ? `<p>Registry entries rejected:</p>
          <ul>${syncState.registryErrors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
        ${failing.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Workflow</th><th>Why</th></tr></thead>
          <tbody>${failing.map((w) => `<tr>
            <td data-label="Workflow">${escapeHtml(w.name)} <span class="faint">${escapeHtml(w.id)}</span></td>
            <td data-label="Why">${escapeHtml(String(w.error ?? '').slice(0, 140))}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="chart-note">History is never erased when a sync fails. These workflows keep the rows and buckets they
        already had; the page is showing older data for them, and this is where it says so.</p>` : ''}
      </div>
    </section>` : ''}
  </div>`;
}

/* ------------------------------------------------------- client script */

/**
 * The timeline painter, the table sorter, the execution filter and the CSV
 * export. Appended to the page's existing client script.
 *
 * ES5-flavoured on purpose, matching the rest of clientScript(): this file is
 * opened straight off disk on whatever browser is to hand, and a build step to
 * transpile it would be a build step to maintain.
 */
export function analyticsScript() {
  return `(function () {
  'use strict';

  var dataEl = document.getElementById('wf-series');
  if (!dataEl) return;
  var SERIES = JSON.parse(dataEl.textContent || '{}');
  var execEl = document.getElementById('wf-executions');
  var EXECUTIONS = execEl ? JSON.parse(execEl.textContent || '{}') : {};

  /* ----------------------------------------------------------- series */

  function hourKey(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + 'T' + p(d.getUTCHours());
  }

  /* The packed arrays are contiguous from k0, so an index is a key and no
     lookup table is needed. A 0 in the array is an empty bucket. */
  function at(pack, i) {
    var v = pack[i];
    if (!v) return { n: 0, ok: 0, fail: 0, items: 0, msSum: 0, covered: 0 };
    return { n: v[0], ok: v[1], fail: v[2], items: v[3], msSum: v[4], covered: v[5] };
  }

  function offsetOf(k0, key) {
    // Keys are "YYYY-MM-DDTHH" on an hour grid, so Date arithmetic on the UTC
    // reading of each is exactly the number of buckets between them.
    var a = Date.parse(k0.slice(0, 10) + 'T' + k0.slice(11, 13) + ':00:00Z');
    var b = Date.parse(key.slice(0, 10) + 'T' + key.slice(11, 13) + ':00:00Z');
    return Math.round((b - a) / 3600000);
  }

  function window_(key, grain, hours, custom) {
    var to = new Date();
    var from = new Date(to.getTime() - hours * 3600000);
    if (custom && custom.from) { from = new Date(custom.from + 'T00:00:00Z'); }
    if (custom && custom.to) { to = new Date(custom.to + 'T23:59:59Z'); }
    return { from: from, to: to, grain: grain };
  }

  /** Points for one workflow over one window, at the right resolution. */
  function pointsFor(key, win) {
    var s = SERIES[key];
    if (!s) return [];
    var spanH = (win.to - win.from) / 3600000;
    var useDaily = spanH > 24 * 8;
    var pack = useDaily ? s.d : s.h;
    var k0 = useDaily ? s.k0d : s.k0h;
    if (!k0 || !pack.length) return [];

    var step = useDaily ? 24 : 1;
    var out = [];
    var cursor = new Date(Math.floor(win.from.getTime() / 3600000) * 3600000);
    var groupH = spanH > 24 * 45 ? 24 * 7 : (useDaily ? 24 : 1);
    var bucket = null;
    var bucketKey = null;

    for (var t = cursor.getTime(); t <= win.to.getTime(); t += step * 3600000) {
      var d = new Date(t);
      var k = useDaily ? hourKey(d).slice(0, 10) : hourKey(d);
      var i = useDaily
        ? Math.round((Date.parse(k + 'T00:00:00Z') - Date.parse(k0 + 'T00:00:00Z')) / 86400000)
        : offsetOf(k0, k);
      var v = (i >= 0 && i < pack.length) ? at(pack, i) : { n: 0, ok: 0, fail: 0, items: 0, msSum: 0, covered: 0 };

      var gk = groupH >= 24 * 7
        ? new Date(t - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10)
        : k;
      if (gk !== bucketKey) {
        bucket = { key: gk, n: 0, ok: 0, fail: 0, items: 0, msSum: 0, covered: 0 };
        out.push(bucket);
        bucketKey = gk;
      }
      bucket.n += v.n; bucket.ok += v.ok; bucket.fail += v.fail;
      bucket.items += v.items; bucket.msSum += v.msSum; bucket.covered += v.covered;
    }
    return out;
  }

  /* ----------------------------------------------------------- painter */

  var NS = 'http://www.w3.org/2000/svg';

  function paint(svg, win) {
    var keys = (svg.getAttribute('data-workflows') || '').split(',').filter(Boolean);
    var measure = svg.getAttribute('data-measure');
    var stacked = svg.getAttribute('data-stacked') === '1';

    /* Sum the series of every workflow named on the chart, so the estate-wide
       plot and a single workflow's plot are the same code path. */
    var merged = null;
    for (var ki = 0; ki < keys.length; ki += 1) {
      var pts = pointsFor(keys[ki], win);
      if (!merged) { merged = pts.map(function (p) { return { key: p.key, n: p.n, ok: p.ok, fail: p.fail, items: p.items, msSum: p.msSum, covered: p.covered }; }); continue; }
      for (var pi = 0; pi < pts.length && pi < merged.length; pi += 1) {
        merged[pi].n += pts[pi].n; merged[pi].ok += pts[pi].ok; merged[pi].fail += pts[pi].fail;
        merged[pi].items += pts[pi].items; merged[pi].msSum += pts[pi].msSum; merged[pi].covered += pts[pi].covered;
      }
    }
    merged = merged || [];

    var box = svg.getAttribute('viewBox').split(' ');
    var W = Number(box[2]);
    var H = Number(box[3]);
    var padL = 46; var padB = 18; var padT = 8;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var value = function (p) {
      if (measure === 'items') return p.items;
      if (measure === 'throughput') return p.covered ? p.items : 0;
      return p.n;
    };
    var max = 0;
    for (var i = 0; i < merged.length; i += 1) max = Math.max(max, value(merged[i]));

    var caption = svg.parentNode.querySelector('[data-plot-caption]');
    if (!merged.length || max === 0) {
      var t = document.createElementNS(NS, 'text');
      t.setAttribute('x', String(W / 2)); t.setAttribute('y', String(H / 2));
      t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'axis-note');
      t.textContent = measure === 'items'
        ? 'No item counts in this window. Node data is what carries them.'
        : 'No executions in this window.';
      svg.appendChild(t);
      if (caption) caption.textContent = 'Nothing recorded between ' + win.from.toISOString().slice(0, 16).replace('T', ' ')
        + ' and ' + win.to.toISOString().slice(0, 16).replace('T', ' ') + ' UTC.';
      return;
    }

    /* y axis: three gridlines, labelled. Enough to read a magnitude off,
       few enough not to become the loudest thing on the chart. */
    for (var g = 0; g <= 2; g += 1) {
      var yv = max * (g / 2);
      var y = padT + (H - padT - padB) * (1 - g / 2);
      var line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(padL)); line.setAttribute('x2', String(W));
      line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
      line.setAttribute('class', 'wf-grid');
      svg.appendChild(line);
      var lab = document.createElementNS(NS, 'text');
      lab.setAttribute('x', String(padL - 8)); lab.setAttribute('y', String(y + 3));
      lab.setAttribute('text-anchor', 'end'); lab.setAttribute('class', 'axis-label');
      lab.textContent = yv >= 10000 ? Math.round(yv / 1000) + 'k' : String(Math.round(yv));
      svg.appendChild(lab);
    }

    var plotW = W - padL;
    var bw = Math.max(1, plotW / merged.length);
    var gap = bw > 4 ? 1 : 0;

    for (var b = 0; b < merged.length; b += 1) {
      var p = merged[b];
      var v = value(p);
      if (v <= 0) continue;
      var x = padL + b * bw;
      var full = (v / max) * (H - padT - padB);

      if (stacked && p.fail > 0) {
        var failH = (p.fail / max) * (H - padT - padB);
        var okH = full - failH;
        svg.appendChild(rect(x, padT + (H - padT - padB) - full, bw - gap, Math.max(okH, 0), 'var(--s1)'));
        svg.appendChild(rect(x, padT + (H - padT - padB) - failH, bw - gap, failH, 'var(--critical)'));
      } else {
        svg.appendChild(rect(x, padT + (H - padT - padB) - full, bw - gap, full,
          stacked ? 'var(--s1)' : 'var(--s3)'));
      }

      var title = document.createElementNS(NS, 'title');
      title.textContent = p.key + ' — ' + p.n + ' execution' + (p.n === 1 ? '' : 's')
        + (p.fail ? ', ' + p.fail + ' failed' : '')
        + (p.covered ? ', ' + p.items.toLocaleString() + ' items' : '')
        + (p.n ? ', avg ' + Math.round(p.msSum / p.n) + 'ms' : '');
      svg.lastChild.appendChild(title);
    }

    /* x axis: first, middle and last label only. A label per bar is unreadable
       at 168 bars and a lie about precision at 24. */
    [0, Math.floor(merged.length / 2), merged.length - 1].forEach(function (idx, j) {
      if (idx < 0 || !merged[idx]) return;
      var tx = document.createElementNS(NS, 'text');
      tx.setAttribute('x', String(padL + idx * bw + (j === 2 ? -4 : 0)));
      tx.setAttribute('y', String(H - 4));
      tx.setAttribute('text-anchor', j === 0 ? 'start' : (j === 2 ? 'end' : 'middle'));
      tx.setAttribute('class', 'axis-label');
      var k = merged[idx].key;
      tx.textContent = k.length > 10 ? k.slice(11, 13) + ':00' : k.slice(5);
      svg.appendChild(tx);
    });

    if (caption) {
      var totalRuns = 0; var totalItems = 0; var totalFail = 0; var covered = 0;
      for (var s2 = 0; s2 < merged.length; s2 += 1) {
        totalRuns += merged[s2].n; totalItems += merged[s2].items;
        totalFail += merged[s2].fail; covered += merged[s2].covered;
      }
      caption.textContent = merged.length + ' buckets · ' + totalRuns.toLocaleString() + ' executions · '
        + totalFail.toLocaleString() + ' failed · '
        + (covered ? totalItems.toLocaleString() + ' items on ' + covered.toLocaleString() + ' of ' + totalRuns.toLocaleString() + ' executions' : 'no item counts');
    }
  }

  function rect(x, y, w, h, fill) {
    var r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', x.toFixed(1)); r.setAttribute('y', y.toFixed(1));
    r.setAttribute('width', Math.max(0.5, w).toFixed(1)); r.setAttribute('height', Math.max(0.5, h).toFixed(1));
    r.setAttribute('fill', fill); r.setAttribute('class', 'bar');
    return r;
  }

  var RANGES = ${JSON.stringify(RANGES.map((r) => ({ id: r.id, hours: r.hours })))};
  var state = {};

  function repaint(groupEl) {
    var group = groupEl.getAttribute('data-chart-group');
    var st = state[group] || { range: '24h', custom: null };
    var def = RANGES.filter(function (r) { return r.id === st.range; })[0] || RANGES[3];
    var win = window_(null, 'hour', def.hours, st.custom);
    var scope = groupEl.parentNode;
    var plots = scope.querySelectorAll('.wf-plot');
    for (var i = 0; i < plots.length; i += 1) paint(plots[i], win);
  }

  function wireGroup(groupEl) {
    var group = groupEl.getAttribute('data-chart-group');
    state[group] = { range: '24h', custom: null };

    groupEl.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-range]');
      if (!chip) return;
      var chips = groupEl.querySelectorAll('[data-range]');
      for (var i = 0; i < chips.length; i += 1) chips[i].setAttribute('aria-pressed', String(chips[i] === chip));
      state[group] = { range: chip.getAttribute('data-range'), custom: null };
      var dates = groupEl.querySelectorAll('[data-custom]');
      for (var d = 0; d < dates.length; d += 1) dates[d].value = '';
      repaint(groupEl);
    });

    groupEl.addEventListener('change', function (e) {
      if (!e.target.matches('[data-custom]')) return;
      var from = groupEl.querySelector('[data-custom="from"]').value;
      var to = groupEl.querySelector('[data-custom="to"]').value;
      if (!from && !to) return;
      state[group] = { range: 'custom', custom: { from: from || null, to: to || null } };
      var chips = groupEl.querySelectorAll('[data-range]');
      for (var i = 0; i < chips.length; i += 1) chips[i].setAttribute('aria-pressed', 'false');
      repaint(groupEl);
    });

    repaint(groupEl);
  }

  var groups = document.querySelectorAll('[data-chart-group]');
  for (var gi = 0; gi < groups.length; gi += 1) wireGroup(groups[gi]);

  /* A plot inside a drawer has no layout until the drawer opens, which is
     harmless for <rect> arithmetic in a viewBox — but a workflow panel built
     after first paint still needs one. Repaint on open. */
  document.addEventListener('click', function (e) {
    if (!e.target.closest('[data-open]')) return;
    setTimeout(function () {
      var open = document.querySelectorAll('.drawer-panel[data-active] [data-chart-group]');
      for (var i = 0; i < open.length; i += 1) repaint(open[i]);
    }, 30);
  });

  /* ------------------------------------------------------ table sorting */

  var table = document.getElementById('wf-cross-table');
  if (table) {
    var dir = {};
    table.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.tabIndex = 0;
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        dir[key] = dir[key] === 'asc' ? 'desc' : 'asc';
        var sign = dir[key] === 'asc' ? 1 : -1;
        var body = table.querySelector('tbody');
        var rows = Array.prototype.slice.call(body.querySelectorAll('tr'));
        rows.sort(function (a, b) {
          var x = a.getAttribute('data-' + key);
          var y = b.getAttribute('data-' + key);
          var nx = Number(x); var ny = Number(y);
          if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * sign;
          return String(x).localeCompare(String(y)) * sign;
        });
        rows.forEach(function (r) { body.appendChild(r); });
        table.querySelectorAll('th[data-sort]').forEach(function (o) { o.removeAttribute('aria-sort'); });
        th.setAttribute('aria-sort', dir[key] === 'asc' ? 'ascending' : 'descending');
      });
      th.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); th.click(); }
      });
    });
  }

  /* ------------------------------------------------- cross-table filters */

  var filterBar = document.getElementById('wf-filters');
  if (filterBar && table) {
    var picked = {};

    var apply = function () {
      var rows = table.querySelectorAll('tbody tr');
      var shown = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        var ok = true;
        for (var group in picked) {
          var want = picked[group];
          if (!want || want === 'all') continue;
          if (group === 'health') {
            var state = row.getAttribute('data-health-state');
            ok = want === 'attention'
              ? (state !== 'HEALTHY' && state !== 'UNKNOWN')
              : state === want;
          } else if (group === 'project') {
            var p = row.getAttribute('data-project');
            ok = want === '~none' ? p === '~' : p === want.toLowerCase();
          } else if (group === 'instance') {
            ok = row.getAttribute('data-instance') === want;
          } else if (group === 'anomaly') {
            ok = row.getAttribute(want === 'anomaly' ? 'data-anomaly' : 'data-failing') === '1';
          }
          if (!ok) break;
        }
        row.hidden = !ok;
        if (ok) shown += 1;
      }

      /* An empty table is a dead end. Say what is filtered and offer the way
         back, rather than leaving a heading above nothing. */
      var empty = document.getElementById('wf-filter-empty');
      if (empty) {
        empty.hidden = shown > 0;
        if (!shown) empty.textContent = 'No workflow matches every filter above. Clear one to widen it.';
      }
      var countEl = document.getElementById('wf-filter-count');
      if (countEl) countEl.textContent = shown === rows.length ? '' : shown + ' of ' + rows.length;
    };

    filterBar.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-value]');
      if (!chip) return;
      var groupEl = chip.closest('[data-filter-group]');
      var group = groupEl.getAttribute('data-filter-group');
      var value = chip.getAttribute('data-value');
      /* Clicking the active chip again clears that group — otherwise the only
         way out of a filter is to find the All chip, which is one more thing
         to look for than it is worth. */
      picked[group] = picked[group] === value ? 'all' : value;

      var chips = groupEl.querySelectorAll('[data-value]');
      for (var i = 0; i < chips.length; i += 1) {
        chips[i].setAttribute('aria-pressed', String(chips[i].getAttribute('data-value') === picked[group]));
      }
      apply();
    });
  }

  /* --------------------------------------------- execution filter + CSV */

  document.addEventListener('click', function (e) {
    var chip = e.target.closest('[data-exec-filter] [data-status]');
    if (chip) {
      var bar = chip.closest('[data-exec-filter]');
      var want = chip.getAttribute('data-status');
      bar.querySelectorAll('[data-status]').forEach(function (c) {
        c.setAttribute('aria-pressed', String(c === chip));
      });
      var tbl = document.querySelector('.exec-table[data-exec="' + bar.getAttribute('data-exec-filter') + '"]');
      if (tbl) {
        tbl.querySelectorAll('tbody tr').forEach(function (row) {
          row.hidden = want !== 'all' && row.getAttribute('data-status') !== want;
        });
      }
      return;
    }

    var csv = e.target.closest('[data-csv]');
    if (!csv) return;
    var key = csv.getAttribute('data-csv');
    /* From the packed island, not from the rendered table. The table shows a
       screenful; the export is the whole held history, and scraping the DOM
       would have silently handed over only what happened to be on screen. */
    var store = EXECUTIONS[key];
    if (!store) return;

    var quote = function (v) {
      var s = v === null || v === undefined ? '' : String(v);
      /* Excel reads a leading =, +, - or @ as a formula. An n8n error message
         is remote text and could start with one. */
      if (/^[=+\\-@]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    var lines = [store.cols.map(quote).join(',')];
    for (var r = 0; r < store.rows.length; r += 1) lines.push(store.rows[r].map(quote).join(','));

    /* BOM: without it Excel opens UTF-8 as the system codepage and every
       non-ASCII character in a workflow name arrives as mojibake. */
    var blob = new Blob(['\\ufeff' + lines.join('\\r\\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = key + '-executions.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
}());`;
}
