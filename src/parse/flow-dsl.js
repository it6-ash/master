/**
 * Parser for the flow DSL (brief §7). One statement per line:
 *
 *   <kind> <id> "<label>" "<sublabel>" [state] [@x,y]
 *   edge <from> -> <to> [state] ["label"]
 *
 * This module produces the AST only. Auto-layout and the animated SVG
 * renderer are Stage 5 (src/render/flow-svg.js) and consume this output.
 * validate needs the AST now, to prove every edge endpoint exists.
 *
 * Never throws. Malformed lines are recorded and skipped; the rest of the
 * block still parses.
 */

export const KINDS = ['node', 'store', 'ext', 'group'];
export const STATES = ['live', 'data', 'idle', 'broken'];

const POS_RE = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

/**
 * @typedef {{ id: string, kind: string, label: string, sublabel: string|null,
 *             state: string|null, x: number|null, y: number|null, line: number }} FlowNode
 * @typedef {{ from: string, to: string, state: string|null,
 *             label: string|null, line: number }} FlowEdge
 */

/**
 * @param {string} source
 * @param {{ startLine?: number }} [opts] line number of the block's FIRST code line
 * @returns {{ nodes: FlowNode[], edges: FlowEdge[],
 *             errors: Array<{line:number,message:string}>,
 *             warnings: Array<{line:number,message:string}> }}
 */
export function parseFlow(source, { startLine = 1 } = {}) {
  /** @type {FlowNode[]} */ const nodes = [];
  /** @type {FlowEdge[]} */ const edges = [];
  const errors = [];
  const warnings = [];
  const byId = new Map();
  let sawGroup = false;

  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');

  lines.forEach((raw, i) => {
    const lineNo = startLine + i;
    const tokens = tokenize(raw, lineNo, errors);
    if (tokens.length === 0) return;

    const head = tokens[0];
    if (head.type !== 'word') {
      errors.push({ line: lineNo, message: `statement must start with a keyword, got ${describe(head)}` });
      return;
    }

    if (head.value === 'edge') {
      const edge = parseEdge(tokens, lineNo, errors);
      if (edge) edges.push(edge);
      return;
    }

    if (!KINDS.includes(head.value)) {
      errors.push({ line: lineNo, message: `unknown statement "${head.value}" — expected one of ${KINDS.join(', ')}, edge` });
      return;
    }

    const node = parseNode(tokens, lineNo, errors);
    if (!node) return;
    if (byId.has(node.id)) {
      errors.push({ line: lineNo, message: `duplicate node id "${node.id}" (first declared on line ${byId.get(node.id)})` });
      return;
    }
    if (node.kind === 'group') sawGroup = true;
    byId.set(node.id, lineNo);
    nodes.push(node);
  });

  // Endpoint resolution — the check the brief calls out as a validate failure.
  for (const edge of edges) {
    if (!byId.has(edge.from)) {
      errors.push({ line: edge.line, message: `edge references undeclared node "${edge.from}"` });
    }
    if (!byId.has(edge.to)) {
      errors.push({ line: edge.line, message: `edge references undeclared node "${edge.to}"` });
    }
  }

  if (sawGroup) {
    warnings.push({ line: startLine, message: 'kind "group" parses but has no layout semantics yet — containers land with the Stage 5 renderer' });
  }

  return { nodes, edges, errors, warnings };
}

/* --------------------------------------------------------------- lexing */

function tokenize(raw, lineNo, errors) {
  const tokens = [];
  const s = raw;
  let i = 0;

  while (i < s.length) {
    const c = s[i];

    if (/\s/.test(c)) { i += 1; continue; }

    if (c === '#') break; // rest of line is a comment

    if (c === '"' || c === "'") {
      const quote = c;
      let value = '';
      i += 1;
      let closed = false;
      while (i < s.length) {
        if (s[i] === '\\' && i + 1 < s.length) { value += s[i + 1]; i += 2; continue; }
        if (s[i] === quote) { closed = true; i += 1; break; }
        value += s[i];
        i += 1;
      }
      if (!closed) {
        errors.push({ line: lineNo, message: 'unterminated quoted string' });
        return [];
      }
      tokens.push({ type: 'string', value });
      continue;
    }

    if (c === '-' && s[i + 1] === '>') {
      tokens.push({ type: 'arrow', value: '->' });
      i += 2;
      continue;
    }

    let word = '';
    while (i < s.length && !/\s/.test(s[i]) && !(s[i] === '-' && s[i + 1] === '>')) {
      word += s[i];
      i += 1;
    }
    tokens.push(POS_RE.test(word) ? { type: 'pos', value: word } : { type: 'word', value: word });
  }

  return tokens;
}

/* -------------------------------------------------------------- parsing */

function parseEdge(tokens, lineNo, errors) {
  const [, from, arrow, to, ...rest] = tokens;

  if (!from || from.type !== 'word') {
    errors.push({ line: lineNo, message: 'edge is missing a source node id' });
    return null;
  }
  if (!arrow || arrow.type !== 'arrow') {
    errors.push({ line: lineNo, message: `expected "->" after "${from.value}"` });
    return null;
  }
  if (!to || to.type !== 'word') {
    errors.push({ line: lineNo, message: `edge from "${from.value}" is missing a target node id` });
    return null;
  }

  const edge = { from: from.value, to: to.value, state: null, label: null, line: lineNo };

  for (const t of rest) {
    if (t.type === 'string') {
      if (edge.label !== null) {
        errors.push({ line: lineNo, message: 'edge has more than one label' });
        continue;
      }
      edge.label = t.value;
    } else if (t.type === 'word' && STATES.includes(t.value)) {
      if (edge.state !== null) {
        errors.push({ line: lineNo, message: `edge has more than one state ("${edge.state}" then "${t.value}")` });
        continue;
      }
      edge.state = t.value;
    } else {
      errors.push({ line: lineNo, message: `unexpected ${describe(t)} on edge — expected a state (${STATES.join('|')}) or a quoted label` });
    }
  }

  return edge;
}

function parseNode(tokens, lineNo, errors) {
  const [kind, id, ...rest] = tokens;

  if (!id || id.type !== 'word') {
    errors.push({ line: lineNo, message: `${kind.value} statement is missing an id` });
    return null;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id.value)) {
    errors.push({ line: lineNo, message: `invalid node id "${id.value}" — use letters, digits, _ and -, starting with a letter` });
    return null;
  }

  const node = {
    id: id.value,
    kind: kind.value,
    label: id.value,
    sublabel: null,
    state: null,
    x: null,
    y: null,
    line: lineNo,
  };

  const strings = [];
  for (const t of rest) {
    if (t.type === 'string') {
      strings.push(t.value);
    } else if (t.type === 'pos') {
      const m = POS_RE.exec(t.value);
      node.x = Number(m[1]);
      node.y = Number(m[2]);
    } else if (t.type === 'word' && STATES.includes(t.value)) {
      if (node.state !== null) {
        errors.push({ line: lineNo, message: `node "${node.id}" has more than one state ("${node.state}" then "${t.value}")` });
        continue;
      }
      node.state = t.value;
    } else {
      errors.push({ line: lineNo, message: `unexpected ${describe(t)} on node "${node.id}" — labels must be quoted` });
    }
  }

  if (strings.length === 0) {
    errors.push({ line: lineNo, message: `node "${node.id}" is missing its quoted label` });
    return null;
  }
  if (strings.length > 2) {
    errors.push({ line: lineNo, message: `node "${node.id}" has ${strings.length} quoted strings — expected label and optional sublabel` });
  }
  node.label = strings[0];
  node.sublabel = strings[1] ?? null;

  return node;
}

const describe = (t) => (t.type === 'string' ? `quoted string ${JSON.stringify(t.value)}` : `"${t.value}"`);

/* --------------------------------------------------- markdown extraction */

/**
 * Pull ```flow and ```mermaid fenced blocks out of a Markdown body,
 * carrying the line number of each block's first code line.
 *
 * @param {string} markdown
 * @param {{ startLine?: number, langs?: string[] }} [opts]
 * @returns {Array<{ lang: string, code: string, startLine: number, fenceLine: number }>}
 */
export function extractFlowBlocks(markdown, { startLine = 1, langs = ['flow', 'mermaid'] } = {}) {
  const blocks = [];
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');

  let open = null;
  lines.forEach((line, i) => {
    const fence = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*([^\s`~]*)/.exec(line);

    if (open) {
      const closing = fence && fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length && fence[3] === '';
      if (closing) {
        blocks.push({
          lang: open.lang,
          code: open.buf.join('\n'),
          startLine: open.startLine,
          fenceLine: open.fenceLine,
        });
        open = null;
      } else {
        open.buf.push(line);
      }
      return;
    }

    if (fence && langs.includes(fence[3].toLowerCase())) {
      open = {
        lang: fence[3].toLowerCase(),
        marker: fence[2],
        buf: [],
        fenceLine: startLine + i,
        startLine: startLine + i + 1,
      };
    }
  });

  // An unclosed fence at EOF still yields its content rather than vanishing.
  if (open) {
    blocks.push({ lang: open.lang, code: open.buf.join('\n'), startLine: open.startLine, fenceLine: open.fenceLine, unterminated: true });
  }

  return blocks;
}
