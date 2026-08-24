/**
 * Splits a Markdown file into frontmatter + body.
 *
 * Returns line numbers for both halves so validate can point at
 * `content/projects/yamini.md:14` instead of "somewhere in the frontmatter".
 * Never throws.
 */

import { parseYaml } from '../lib/yaml-lite.js';

const FENCE = /^---[ \t]*$/;

/**
 * @param {string} text
 * @returns {{
 *   data: Record<string, any>,
 *   body: string,
 *   bodyStartLine: number,
 *   hasFrontmatter: boolean,
 *   errors: Array<{ line: number, message: string }>
 * }}
 */
export function parseFrontmatter(text) {
  const errors = [];
  const source = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');

  if (!FENCE.test(lines[0] ?? '')) {
    errors.push({ line: 1, message: 'missing frontmatter — the file must begin with a "---" line' });
    return { data: {}, body: source, bodyStartLine: 1, hasFrontmatter: false, errors };
  }

  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FENCE.test(lines[i]) || /^\.\.\.[ \t]*$/.test(lines[i])) { close = i; break; }
  }

  if (close === -1) {
    errors.push({ line: 1, message: 'unterminated frontmatter — no closing "---" found' });
    return { data: {}, body: source, bodyStartLine: 1, hasFrontmatter: false, errors };
  }

  const yaml = lines.slice(1, close).join('\n');
  const parsed = parseYaml(yaml, { startLine: 2 });
  errors.push(...parsed.errors);

  let data = parsed.value;
  if (data === null) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    errors.push({ line: 2, message: 'frontmatter must be a mapping of keys to values' });
    data = {};
  }

  return {
    data,
    body: lines.slice(close + 1).join('\n'),
    bodyStartLine: close + 2,
    hasFrontmatter: true,
    errors,
  };
}
