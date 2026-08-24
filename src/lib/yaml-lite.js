/**
 * A deliberately small YAML parser covering exactly the subset the project
 * frontmatter contract uses (see schema/project-frontmatter.schema.json):
 *
 *   key: scalar                 # with trailing comments
 *   key: [a, b, c]              # flow sequence, bare items may contain spaces
 *   key:
 *     - { value: "x", label: "y" }   # block sequence of flow maps
 *     - nested:
 *         deeper: true
 *
 * Not supported, and reported as an error rather than mis-parsed: block
 * scalars (| >), anchors/aliases, multi-document streams, tab indentation,
 * complex keys. If the frontmatter ever needs those, replace this with
 * gray-matter — but the whole file stays dependency-free today.
 *
 * Every failure is a structured error; nothing throws.
 */

/** @typedef {{ line: number, message: string }} YamlError */

export function parseYaml(text, { startLine = 1 } = {}) {
  /** @type {YamlError[]} */
  const errors = [];
  const lines = [];

  const src = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

  src.forEach((raw, i) => {
    const n = startLine + i;
    if (/^[ ]*\t/.test(raw)) {
      errors.push({ line: n, message: 'tab character in indentation (YAML forbids tabs; use spaces)' });
      return;
    }
    const stripped = stripComment(raw, n, errors);
    if (stripped.trim() === '') return;
    lines.push({ n, indent: stripped.match(/^ */)[0].length, text: stripped.trim() });
  });

  if (lines.length === 0) return { value: {}, errors };

  const baseIndent = lines[0].indent;
  const [value, next] = parseNode(lines, 0, baseIndent, errors);

  if (next < lines.length) {
    errors.push({ line: lines[next].n, message: `unexpected indentation (expected ${baseIndent} spaces, got ${lines[next].indent})` });
  }
  return { value, errors };
}

/* --------------------------------------------------------------- lexing */

function stripComment(raw, lineNo, errors) {
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  if (quote) errors.push({ line: lineNo, message: `unterminated ${quote === '"' ? 'double' : 'single'} quote` });
  return raw;
}

const isSeqEntry = (line) => line.text === '-' || line.text.startsWith('- ');

/* -------------------------------------------------------------- parsing */

function parseNode(lines, idx, indent, errors) {
  if (idx >= lines.length) return [null, idx];
  return isSeqEntry(lines[idx])
    ? parseSeq(lines, idx, indent, errors)
    : parseMap(lines, idx, indent, errors);
}

function parseSeq(lines, idx, indent, errors) {
  const items = [];
  while (idx < lines.length && lines[idx].indent === indent && isSeqEntry(lines[idx])) {
    const line = lines[idx];
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();

    if (rest === '') {
      const next = lines[idx + 1];
      if (next && next.indent > indent) {
        const [value, after] = parseNode(lines, idx + 1, next.indent, errors);
        items.push(value);
        idx = after;
      } else {
        items.push(null);
        idx += 1;
      }
      continue;
    }

    // `- key: value` starts a map whose first key sits where `rest` begins.
    if (!/^[[{'"]/.test(rest) && /^[^:\s][^:]*:(\s|$)/.test(rest)) {
      const childIndent = line.indent + line.text.indexOf(rest);
      lines[idx] = { n: line.n, indent: childIndent, text: rest };
      const [value, after] = parseMap(lines, idx, childIndent, errors);
      items.push(value);
      idx = after;
      continue;
    }

    items.push(parseScalar(rest, line.n, errors));
    idx += 1;
  }
  return [items, idx];
}

function parseMap(lines, idx, indent, errors) {
  const map = {};
  while (idx < lines.length && lines[idx].indent === indent && !isSeqEntry(lines[idx])) {
    const line = lines[idx];
    const split = splitKey(line.text);

    if (!split) {
      errors.push({ line: line.n, message: `expected "key: value", got ${JSON.stringify(truncate(line.text))}` });
      idx += 1;
      continue;
    }

    const { key, rest } = split;
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      errors.push({ line: line.n, message: `duplicate key "${key}"` });
    }

    if (rest === '') {
      const next = lines[idx + 1];
      if (next && next.indent > indent) {
        const [value, after] = parseNode(lines, idx + 1, next.indent, errors);
        map[key] = value;
        idx = after;
      } else if (next && next.indent === indent && isSeqEntry(next)) {
        // Sequence not indented past its key — legal YAML, common in the wild.
        const [value, after] = parseSeq(lines, idx + 1, indent, errors);
        map[key] = value;
        idx = after;
      } else {
        map[key] = null;
        idx += 1;
      }
      continue;
    }

    if (/^[|>]/.test(rest)) {
      errors.push({ line: line.n, message: 'block scalars (| and >) are not supported in frontmatter' });
      map[key] = null;
      idx += 1;
      continue;
    }

    map[key] = parseScalar(rest, line.n, errors);
    idx += 1;
  }
  return [map, idx];
}

function splitKey(text) {
  if (text[0] === '"' || text[0] === "'") {
    const quote = text[0];
    for (let i = 1; i < text.length; i += 1) {
      if (text[i] === '\\' && quote === '"') { i += 1; continue; }
      if (text[i] === quote) {
        const after = text.slice(i + 1);
        const m = /^\s*:(\s|$)/.exec(after);
        if (!m) return null;
        return { key: text.slice(1, i), rest: after.slice(after.indexOf(':') + 1).trim() };
      }
    }
    return null;
  }
  const m = /^([^:]+):(\s|$)/.exec(text);
  if (!m) return null;
  return { key: m[1].trim(), rest: text.slice(m[1].length + 1).trim() };
}

/* -------------------------------------------------------------- scalars */

function parseScalar(s, lineNo, errors) {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;

  if (t.startsWith('[')) {
    if (!t.endsWith(']')) {
      errors.push({ line: lineNo, message: 'unterminated flow sequence — missing "]"' });
      return [];
    }
    const inner = t.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner, lineNo, errors).map((part) => parseScalar(part, lineNo, errors));
  }

  if (t.startsWith('{')) {
    if (!t.endsWith('}')) {
      errors.push({ line: lineNo, message: 'unterminated flow mapping — missing "}"' });
      return {};
    }
    const inner = t.slice(1, -1).trim();
    const out = {};
    if (inner === '') return out;
    for (const part of splitTopLevel(inner, lineNo, errors)) {
      const split = splitKey(part.trim());
      if (!split) {
        errors.push({ line: lineNo, message: `expected "key: value" inside { }, got ${JSON.stringify(truncate(part))}` });
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(out, split.key)) {
        errors.push({ line: lineNo, message: `duplicate key "${split.key}" inside { }` });
      }
      out[split.key] = parseScalar(split.rest, lineNo, errors);
    }
    return out;
  }

  if ((t.startsWith('"') && t.endsWith('"') && t.length > 1)
    || (t.startsWith("'") && t.endsWith("'") && t.length > 1)) {
    return unquote(t, lineNo, errors);
  }

  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?(?:\d+\.\d+|\.\d+)$/.test(t)) return Number(t);

  return t;
}

function unquote(t, lineNo, errors) {
  const quote = t[0];
  const body = t.slice(1, -1);
  if (quote === "'") return body.replace(/''/g, "'");
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, esc) => {
    if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
    switch (esc) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      default:
        errors.push({ line: lineNo, message: `unknown escape "\\${esc}"` });
        return esc;
    }
  });
}

function splitTopLevel(s, lineNo, errors) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[' || c === '{') { depth += 1; continue; }
    if (c === ']' || c === '}') { depth -= 1; continue; }
    if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (quote) errors.push({ line: lineNo, message: 'unterminated quote inside flow collection' });
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

const truncate = (s, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);
