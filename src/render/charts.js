/**
 * Charts for the estate dashboard.
 *
 * Built to the dataviz method: form chosen by the data's job, color assigned by
 * the job it does, palette validated against this page's dark surface
 * (#14161c) before use. Every chart ships a table-view twin, so no value is
 * reachable only by hovering.
 *
 * All marks are plain SVG with CSS classes. No chart library, no runtime JS,
 * and hover tooltips come from native <title> so they survive file:// and print.
 */

import { escapeHtml } from './markdown.js';

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n ?? ''));

/** Ordinal ramp, dark mode. Never darker than step 600 (the 2:1 floor). */
const ORDINAL_DARK = ['#86b6ef', '#3987e5', '#1c5cab'];

/**
 * A table-view twin for any chart. The WCAG-clean equivalent.
 */
function tableView(headers, rows, { label = 'Table view' } = {}) {
  return `<details class="table-view">
    <summary>${escapeHtml(label)}</summary>
    <div class="table-wrap"><table>
      <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i > 0 ? ' class="num"' : ''}>${escapeHtml(String(c))}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
  </details>`;
}

function legend(items) {
  return `<div class="legend">${items.map((i) => `<span class="legend-item">
    <span class="legend-swatch" style="background:${i.color}"></span>${escapeHtml(i.label)}
  </span>`).join('')}</div>`;
}

/* ------------------------------------------------------------- funnel */

/**
 * Ordered stages with a collapse at the end. Horizontal bars on a linear scale,
 * every stage direct-labeled — the whole point is that stage 2 is a sliver and
 * stage 3 is nothing, and a log scale would hide exactly that.
 *
 * @param {Array<{label: string, value: number, note?: string, broken?: boolean}>} stages
 */
export function funnelChart(stages, { title = 'Funnel', id = 'funnel' } = {}) {
  const max = Math.max(...stages.map((s) => s.value), 1);
  const rowH = 46;
  const barH = 14;
  const labelW = 168;
  const width = 560;
  const trackW = width - labelW - 84;
  const height = stages.length * rowH + 8;

  const rows = stages.map((stage, i) => {
    const y = i * rowH + 12;
    const w = Math.max(0, (stage.value / max) * trackW);
    const color = ORDINAL_DARK[Math.min(i, ORDINAL_DARK.length - 1)];
    const pct = max > 0 ? ((stage.value / max) * 100) : 0;

    // A zero stage renders as the empty track only; the value sits outside it.
    const bar = w > 0
      ? `<rect class="bar" x="${labelW}" y="${y}" width="${w.toFixed(1)}" height="${barH}" rx="4" fill="${color}">
           <title>${escapeHtml(stage.label)}: ${fmt(stage.value)} (${pct.toFixed(1)}% of the top stage)</title>
         </rect>`
      : '';

    return `<g class="funnel-row">
      <text class="axis-label" x="${labelW - 12}" y="${y + barH - 2}" text-anchor="end">${escapeHtml(stage.label)}</text>
      <rect class="track" x="${labelW}" y="${y}" width="${trackW}" height="${barH}" rx="4" />
      ${bar}
      <text class="value-label${stage.broken ? ' value-label--critical' : ''}" x="${labelW + Math.max(w, 0) + 10}" y="${y + barH - 2}">${fmt(stage.value)}</text>
      ${stage.broken ? `<text class="value-flag" x="${labelW + Math.max(w, 0) + 10 + String(fmt(stage.value)).length * 7.4 + 8}" y="${y + barH - 2}">✕ never runs</text>` : ''}
      ${stage.note ? `<text class="axis-note" x="${labelW}" y="${y + barH + 15}">${escapeHtml(stage.note)}</text>` : ''}
    </g>`;
  }).join('\n');

  return `<figure class="chart" id="${id}">
    <figcaption>${escapeHtml(title)}</figcaption>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="xMinYMin meet">
      ${rows}
    </svg>
    ${tableView(['Stage', 'Records'], stages.map((s) => [s.label, fmt(s.value)]))}
  </figure>`;
}

/* --------------------------------------------------- grouped workflows */

/**
 * Emphasis, not eight hues: active workflows carry the accent, everything else
 * is the de-emphasis gray. The story is "12 of these run", not "here are seven
 * equally interesting categories".
 *
 * @param {Array<{group: string, active: number, inactive: number}>} groups
 */
export function workflowChart(groups, { title = 'Workflows by group', id = 'wf-chart' } = {}) {
  const ACTIVE = '#3987e5';
  const IDLE = '#4a5163';

  const max = Math.max(...groups.map((g) => g.active + g.inactive), 1);
  const rowH = 34;
  const barH = 13;
  const labelW = 116;
  const width = 560;
  const trackW = width - labelW - 76;
  const height = groups.length * rowH + 6;

  const rows = groups.map((g, i) => {
    const y = i * rowH + 10;
    const total = g.active + g.inactive;
    const activeW = (g.active / max) * trackW;
    const inactiveW = (g.inactive / max) * trackW;
    // 2px surface gap between adjacent fills, never a border.
    const gap = g.active > 0 && g.inactive > 0 ? 2 : 0;

    return `<g>
      <text class="axis-label" x="${labelW - 12}" y="${y + barH - 2}" text-anchor="end">${escapeHtml(g.group)}</text>
      ${g.active > 0 ? `<rect class="bar" x="${labelW}" y="${y}" width="${activeW.toFixed(1)}" height="${barH}" rx="4" fill="${ACTIVE}">
        <title>${escapeHtml(g.group)}: ${g.active} active</title></rect>` : ''}
      ${g.inactive > 0 ? `<rect class="bar" x="${(labelW + activeW + gap).toFixed(1)}" y="${y}" width="${Math.max(0, inactiveW - gap).toFixed(1)}" height="${barH}" rx="4" fill="${IDLE}">
        <title>${escapeHtml(g.group)}: ${g.inactive} inactive</title></rect>` : ''}
      <text class="value-label" x="${(labelW + activeW + inactiveW + 10).toFixed(1)}" y="${y + barH - 2}">${g.active > 0 ? `${g.active} of ${total}` : fmt(total)}</text>
    </g>`;
  }).join('\n');

  return `<figure class="chart" id="${id}">
    <figcaption>${escapeHtml(title)}</figcaption>
    ${legend([{ label: 'Active', color: ACTIVE }, { label: 'Inactive', color: IDLE }])}
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="xMinYMin meet">
      ${rows}
    </svg>
    ${tableView(['Group', 'Active', 'Inactive', 'Total'],
    groups.map((g) => [g.group, g.active, g.inactive, g.active + g.inactive]))}
  </figure>`;
}

/* ---------------------------------------------------------- cost model */

/**
 * Part-to-whole across three volume scenarios. Two categorical series, stacked
 * horizontally, so the reader sees at a glance that WhatsApp broadcast fees are
 * the bill and the model tokens are rounding error.
 *
 * @param {Array<{scenario: string, whatsapp: number, openai: number, note?: string}>} rows
 */
export function costChart(rows, { title = 'Monthly cost', id = 'cost-chart' } = {}) {
  const WHATSAPP = '#d95926';
  const OPENAI = '#3987e5';

  const max = Math.max(...rows.map((r) => r.whatsapp + r.openai), 1);
  const rowH = 52;
  const barH = 16;
  const labelW = 116;
  const width = 560;
  const trackW = width - labelW - 96;
  const height = rows.length * rowH + 6;

  const bars = rows.map((r, i) => {
    const y = i * rowH + 12;
    const total = r.whatsapp + r.openai;
    const wsW = (r.whatsapp / max) * trackW;
    const aiW = (r.openai / max) * trackW;
    const share = Math.round((r.whatsapp / total) * 100);

    return `<g>
      <text class="axis-label" x="${labelW - 12}" y="${y + barH - 3}" text-anchor="end">${escapeHtml(r.scenario)}</text>
      <rect class="bar" x="${labelW}" y="${y}" width="${wsW.toFixed(1)}" height="${barH}" rx="4" fill="${WHATSAPP}">
        <title>${escapeHtml(r.scenario)} — WhatsApp: ₹${fmt(r.whatsapp)} (${share}%)</title></rect>
      <rect class="bar" x="${(labelW + wsW + 2).toFixed(1)}" y="${y}" width="${Math.max(0, aiW - 2).toFixed(1)}" height="${barH}" rx="4" fill="${OPENAI}">
        <title>${escapeHtml(r.scenario)} — OpenAI: ₹${fmt(r.openai)} (${100 - share}%)</title></rect>
      <text class="value-label" x="${(labelW + wsW + aiW + 10).toFixed(1)}" y="${y + barH - 3}">₹${fmt(total)}</text>
      ${r.note ? `<text class="axis-note" x="${labelW}" y="${y + barH + 16}">${escapeHtml(r.note)}</text>` : ''}
    </g>`;
  }).join('\n');

  return `<figure class="chart" id="${id}">
    <figcaption>${escapeHtml(title)}</figcaption>
    ${legend([{ label: 'WhatsApp fees', color: WHATSAPP }, { label: 'OpenAI tokens', color: OPENAI }])}
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="xMinYMin meet">
      ${bars}
    </svg>
    ${tableView(['Scenario', 'WhatsApp ₹', 'OpenAI ₹', 'Total ₹'],
    rows.map((r) => [r.scenario, fmt(r.whatsapp), fmt(r.openai), fmt(r.whatsapp + r.openai)]))}
  </figure>`;
}

/* ------------------------------------------------------------ sparkline */

/** A stat tile's trend, not a chart in its own right. */
export function sparkline(values, { width = 190, height = 28 } = {}) {
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const y = (v) => height - 5 - ((v - min) / span) * (height - 10);

  if (values.length === 1) {
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <line class="spark-baseline" x1="0" y1="${y(values[0])}" x2="${width}" y2="${y(values[0])}" />
      <circle class="spark-dot" cx="${width - 4}" cy="${y(values[0])}" r="2.5" />
    </svg>`;
  }

  const step = width / (values.length - 1);
  const points = values.map((v, i) => [i * step, y(v)]);
  const line = points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
  const [lx, ly] = points[points.length - 1];

  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <path class="spark-area" d="${line} L ${width} ${height} L 0 ${height} Z" />
    <path class="spark-line" d="${line}" />
    <circle class="spark-dot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.5" />
  </svg>`;
}

/* ----------------------------------------------------------- stat tile */

/**
 * The honest answer when the data is one number. Not a one-bar bar chart.
 */
export function statTile({ value, label, note, state, spark }) {
  return `<div class="tile${state ? ` tile--${state}` : ''}">
    <div class="tile-value">${escapeHtml(String(value))}</div>
    <div class="tile-label">${escapeHtml(label)}</div>
    ${note ? `<div class="tile-note">${escapeHtml(note)}</div>` : ''}
    ${spark ? `<div class="tile-spark">${spark}</div>` : ''}
  </div>`;
}
