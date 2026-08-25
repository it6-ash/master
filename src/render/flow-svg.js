/**
 * Auto-layout and SVG rendering for the flow DSL (brief §7).
 *
 * Layout: layered left-to-right. A node's column is its LONGEST path from any
 * root; rows are distributed within a column and then ordered by the mean row
 * of each node's neighbours to pull edges straight. Manual @x,y wins outright.
 *
 * Cycles are expected — Yamini's `db -> qual -> db` is one — so back edges are
 * identified by DFS and excluded from the layering, then drawn as returning
 * curves.
 *
 * Animation is pure CSS (see styles.css). No JavaScript runs for the diagram,
 * which is what keeps it working when the page is printed or opened offline.
 */

import { escapeHtml } from './markdown.js';

const NODE_W = 168;
const NODE_H = 58;
const COL_GAP = 92;
const ROW_GAP = 30;
const PAD = 28;

const COL_STRIDE = NODE_W + COL_GAP;
const ROW_STRIDE = NODE_H + ROW_GAP;

/* ------------------------------------------------------------- layout */

/** Edges that close a cycle, found by DFS colouring. Excluded from layering. */
function findBackEdges(nodes, edges) {
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  edges.forEach((e, index) => {
    if (outgoing.has(e.from) && outgoing.has(e.to)) outgoing.get(e.from).push({ index, to: e.to });
  });

  const WHITE = 0; const GREY = 1; const BLACK = 2;
  const color = new Map(nodes.map((n) => [n.id, WHITE]));
  const back = new Set();

  const visit = (start) => {
    // Iterative DFS so a long chain cannot blow the stack.
    const stack = [{ id: start, next: 0 }];
    color.set(start, GREY);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const list = outgoing.get(frame.id) ?? [];
      if (frame.next >= list.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const { index, to } = list[frame.next];
      frame.next += 1;
      const state = color.get(to);
      if (state === GREY) back.add(index);
      else if (state === WHITE) { color.set(to, GREY); stack.push({ id: to, next: 0 }); }
    }
  };

  const hasIncoming = new Set(edges.map((e) => e.to));
  for (const n of nodes) if (!hasIncoming.has(n.id) && color.get(n.id) === WHITE) visit(n.id);
  for (const n of nodes) if (color.get(n.id) === WHITE) visit(n.id);

  return back;
}

/**
 * @param {object} flow parsed AST
 * @param {{ vertical?: boolean }} [opts] vertical stacks layers top-to-bottom,
 *   which is the only shape that fits a phone. Same graph, transposed axes.
 * @returns {{ nodes: Array, edges: Array, width: number, height: number, vertical: boolean }}
 */
export function layoutFlow(flow, { vertical = false } = {}) {
  const nodes = flow.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = flow.edges.filter((e) => byId.has(e.from) && byId.has(e.to));

  if (nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const backEdges = findBackEdges(nodes, edges);
  const forward = edges.filter((_, i) => !backEdges.has(i));

  /* columns: longest path from a root */
  const col = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false;
    for (const e of forward) {
      const want = col.get(e.from) + 1;
      if (col.get(e.to) < want) { col.set(e.to, want); moved = true; }
    }
    if (!moved) break;
  }

  /* group by column, preserving declaration order as the starting arrangement */
  const columns = new Map();
  for (const n of nodes) {
    const c = col.get(n.id);
    if (!columns.has(c)) columns.set(c, []);
    columns.get(c).push(n);
  }

  /* two barycentre passes to reduce edge crossings */
  const rowOf = new Map();
  const assignRows = () => {
    for (const [, list] of columns) list.forEach((n, i) => rowOf.set(n.id, i));
  };
  assignRows();

  const neighbours = new Map(nodes.map((n) => [n.id, []]));
  for (const e of forward) {
    neighbours.get(e.to).push(e.from);
    neighbours.get(e.from).push(e.to);
  }

  for (let pass = 0; pass < 2; pass += 1) {
    for (const [, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
      const score = new Map();
      list.forEach((n, i) => {
        const near = neighbours.get(n.id).map((id) => rowOf.get(id)).filter((r) => r !== undefined);
        score.set(n.id, near.length ? near.reduce((a, b) => a + b, 0) / near.length : i);
      });
      list.sort((a, b) => score.get(a.id) - score.get(b.id));
    }
    assignRows();
  }

  /* pixel positions */
  const widest = Math.max(...[...columns.values()].map((l) => l.length));

  if (vertical) {
    // Transposed: a layer becomes a ROW, siblings spread across it.
    const V_COL = NODE_W + 16;
    const V_ROW = NODE_H + 54;
    const contentW = widest * V_COL - 16;

    for (const [c, list] of columns) {
      const rowW = list.length * V_COL - 16;
      const left = PAD + (contentW - rowW) / 2;
      list.forEach((n, i) => {
        n.x = left + i * V_COL;
        n.y = PAD + c * V_ROW;
        n.w = NODE_W;
        n.h = NODE_H;
        n.col = c;
      });
    }
  } else {
    const contentH = widest * ROW_STRIDE - ROW_GAP;
    for (const [c, list] of columns) {
      const columnH = list.length * ROW_STRIDE - ROW_GAP;
      const top = PAD + (contentH - columnH) / 2;
      list.forEach((n, i) => {
        // A manual @x,y always wins.
        if (n.x === null || n.y === null) {
          n.x = PAD + c * COL_STRIDE;
          n.y = top + i * ROW_STRIDE;
        }
        n.w = NODE_W;
        n.h = NODE_H;
        n.col = c;
      });
    }
  }

  const width = Math.max(...nodes.map((n) => n.x + n.w)) + PAD;
  const height = Math.max(...nodes.map((n) => n.y + n.h)) + PAD;

  const placed = edges.map((e, i) => ({ ...e, back: backEdges.has(i) }));
  return { nodes, edges: placed, width, height, vertical };
}

/* -------------------------------------------------------------- drawing */

function edgePath(a, b, back, vertical) {
  if (vertical) {
    const startX = a.x + a.w / 2;
    const startY = a.y + a.h;
    const endX = b.x + b.w / 2;
    const endY = b.y;

    if (!back && endY >= startY - 4) {
      const dy = Math.max(22, (endY - startY) * 0.5);
      return `M ${startX} ${startY} C ${startX} ${startY + dy}, ${endX} ${endY - dy}, ${endX} ${endY}`;
    }
    // Returning edge: out the right, back up, in the right.
    const out = 26;
    return `M ${a.x + a.w} ${a.y + a.h / 2} C ${a.x + a.w + out} ${a.y + a.h / 2}, `
      + `${b.x + b.w + out} ${b.y + b.h / 2}, ${b.x + b.w} ${b.y + b.h / 2}`;
  }

  const startX = a.x + a.w;
  const startY = a.y + a.h / 2;
  const endX = b.x;
  const endY = b.y + b.h / 2;

  if (!back && endX >= startX - 4) {
    const dx = Math.max(36, (endX - startX) * 0.5);
    return `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`;
  }

  // Returning edge: leave from the bottom, loop back beneath, re-enter below.
  const fromX = a.x + a.w / 2;
  const fromY = a.y + a.h;
  const toX = b.x + b.w / 2;
  const toY = b.y + b.h;
  const drop = 34 + Math.abs(a.col - b.col) * 6;
  return `M ${fromX} ${fromY} C ${fromX} ${fromY + drop}, ${toX} ${toY + drop}, ${toX} ${toY}`;
}

function nodeShape(n) {
  const { x, y, w, h } = n;
  if (n.kind === 'store') {
    const ry = 7;
    return `<path class="flow-shape flow-shape--store" d="`
      + `M ${x} ${y + ry} `
      + `A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} `
      + `L ${x + w} ${y + h - ry} `
      + `A ${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} `
      + `Z" />`
      + `<path class="flow-store-lid" d="M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}" />`;
  }
  const cls = n.kind === 'ext' ? 'flow-shape flow-shape--ext'
    : n.kind === 'group' ? 'flow-shape flow-shape--group'
      : 'flow-shape';
  return `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="9" />`;
}

/**
 * @param {object} flow parsed flow AST
 * @param {{ id?: string, title?: string }} [opts]
 * @returns {string} inline SVG
 */
/**
 * @param {object} flow parsed AST
 * @param {{ id?: string, title?: string, vertical?: boolean,
 *           links?: Record<string, {href: string, open: string}> }} [opts]
 *   links maps a node id to a destination, which wraps that node in an <a>.
 *   A diagram of things you cannot click is a picture, not a map.
 */
export function renderFlowSvg(flow, {
  id = 'flow', title = 'Flow diagram', vertical = false, links = {}, glossary = {},
} = {}) {
  const { nodes, edges, width, height } = layoutFlow(flow, { vertical });
  if (nodes.length === 0) return '<p class="muted">This flow declares no nodes.</p>';

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const markerId = `${id}-arrow`;

  const edgeSvg = edges.map((e, i) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    const state = e.state ?? 'neutral';
    const d = edgePath(a, b, e.back, vertical);
    // A plain midpoint label, not a textPath. Text on a path that runs
    // right-to-left renders mirrored and unreadable, which is exactly what a
    // returning edge does.
    const midX = vertical
      ? (a.x + a.w / 2 + b.x + b.w / 2) / 2
      : (a.x + a.w + b.x) / 2;
    const midY = vertical
      ? (a.y + a.h + b.y) / 2
      : (a.y + a.h / 2 + b.y + b.h / 2) / 2 - 7;
    const label = e.label
      ? `<text class="flow-edge-label flow-edge-label--${state}" x="${midX.toFixed(1)}" y="${midY.toFixed(1)}">${escapeHtml(e.label)}</text>`
      : '';
    return `<path id="${id}-e${i}" class="flow-edge flow-edge--${state}" d="${d}" marker-end="url(#${markerId}-${state})" />${label}`;
  }).join('\n    ');

  const nodeSvg = nodes.map((n) => {
    const state = n.state ?? 'neutral';
    const cx = n.x + n.w / 2;
    const labelY = n.sublabel ? n.y + n.h / 2 - 3 : n.y + n.h / 2 + 5;
    const sub = n.sublabel
      ? `<text class="flow-sublabel" x="${cx}" y="${n.y + n.h / 2 + 14}">${escapeHtml(clamp(n.sublabel, 26))}</text>`
      : '';
    // Hovering a node explains what it is and why it is in the picture.
    // A native <title> works offline, in print, and for a screen reader.
    //
    // Both halves of the node are consulted, not just the label: a node reading
    // "Meta Cloud API / direct, no BSP" carries two ideas, and the second one
    // is the interesting one.
    const terms = [lookupTerm(n.label, glossary), lookupTerm(n.sublabel, glossary)]
      .filter(Boolean)
      .filter((t, i, all) => all.findIndex((x) => x.what === t.what) === i);

    const tip = terms.length
      ? `<title>${escapeHtml(terms.map((t) => `${t.what} ${t.why}`).join('\n\n'))}</title>`
      : `<title>${escapeHtml([n.label, n.sublabel].filter(Boolean).join(' — '))}</title>`;
    const term = terms[0];

    const group = `<g class="flow-node flow-node--${state} flow-node--${n.kind}${links[n.id] ? ' flow-node--linked' : ''}${term ? ' flow-node--explained' : ''}" data-node="${escapeHtml(n.id)}">
      ${tip}
      ${nodeShape(n)}
      <text class="flow-label" x="${cx}" y="${labelY}">${escapeHtml(clamp(n.label, 22))}</text>
      ${sub}
    </g>`;

    const link = links[n.id];
    return link
      ? `<a href="${escapeHtml(link.href)}" data-open="${escapeHtml(link.open)}">${group}</a>`
      : group;
  }).join('\n    ');

  const markers = ['neutral', 'live', 'data', 'idle', 'broken'].map((state) => `
      <marker id="${markerId}-${state}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path class="flow-arrow flow-arrow--${state}" d="M 0 1 L 7 4 L 0 7 z" />
      </marker>`).join('');

  // Render at natural size inside a scrolling wrapper. Fitting a ten-node chain
  // into an 800px drawer would scale 12px labels down to 4px, which is not a
  // diagram any more. The viewBox is still declared so the drawing stays
  // resolution-independent and scales cleanly when it does have room.
  return `<svg class="flow flow-${vertical ? 'vertical' : 'horizontal'}" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" role="img" aria-label="${escapeHtml(title)}" preserveAspectRatio="xMidYMin meet">
    <title>${escapeHtml(title)}</title>
    <defs>${markers}
    </defs>
    ${edgeSvg}
    ${nodeSvg}
  </svg>`;
}

/**
 * Find the glossary entry for a label. Matches the whole label first, then any
 * term contained in it, longest first — so "Meta Cloud API" wins over "Meta"
 * and a node labelled "MongoDB" still resolves inside "Local MongoDB".
 */
export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function lookupTerm(label, glossary) {
  if (!label || !glossary) return null;
  const text = String(label);
  if (glossary[text]) return glossary[text];

  const hit = Object.keys(glossary)
    .filter((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(text))
    .sort((a, b) => b.length - a.length)[0];

  return hit ? glossary[hit] : null;
}

const clamp = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
