/**
 * Parser for `n8n list:workflow` output, in either form:
 *
 *   <id>|<name>                       full list
 *   <id>|<name>                       with --active=true, a subset
 *
 * A workflow present in the full list but absent from the active list is
 * inactive. When only ONE list is supplied we cannot tell the difference
 * between "the full list" and "the active list", so the caller must say which
 * via `active`. The dump-embedded N8N section supplies both and is preferred.
 */

import { redactString } from '../lib/redact.js';

export const PARSER = 'n8n-list';
export const PARSER_VERSION = '1.0.0';

const ID_RE = /^[A-Za-z0-9_-]{8,36}$/;

/** §8b. First match wins, so the order here is the rule. */
const GROUP_RULES = [
  ['Yamini', /WhatsApp|Yamini|Broadcast|Qualification/i],
  ['Attribution', /Cratio|Meta CAPI|Google Enhanced|Customer Match/i],
  ['HR', /\bCV\b|screening|\bhr\b/i],
  ['Sales QA', /\bCall\s/i],
  ['KW GBT', /\bGB\s/],
  ['Web chat', /web-chat/i],
];

const NOISE_RE = /^\d+-|empty\d|My workflow/i;

export function groupFor(name) {
  for (const [group, re] of GROUP_RULES) if (re.test(name)) return group;
  return 'Ungrouped';
}

export const isNoise = (name) => NOISE_RE.test(String(name ?? '').trim());

/**
 * Pull `id|name` pairs out of a blob, ignoring anything else in it.
 * @returns {Map<string, string>}
 */
export function parseWorkflowLines(text) {
  const out = new Map();
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const idx = line.indexOf('|');
    if (idx <= 0) continue;
    const id = line.slice(0, idx).trim();
    if (!ID_RE.test(id)) continue;
    out.set(id, redactString(line.slice(idx + 1).trim()).text);
  }
  return out;
}

/**
 * @param {string} text
 * @param {{ active?: boolean|null, activeText?: string|null }} [opts]
 *   active     - true when `text` IS the --active=true output
 *   activeText - the --active=true output, when both are available
 * @returns {{ workflows: Record<string, {name: string, active: boolean}>, warnings: string[] }}
 */
export function parseN8nList(text, { active = null, activeText = null } = {}) {
  const warnings = [];
  const all = parseWorkflowLines(text);

  if (all.size === 0) {
    warnings.push('no <id>|<name> lines found');
    return { workflows: {}, warnings };
  }

  let activeIds = null;
  if (activeText != null) {
    activeIds = new Set(parseWorkflowLines(activeText).keys());
  } else if (active === true) {
    activeIds = new Set(all.keys());
  } else if (active === null) {
    warnings.push('no --active=true list supplied — every workflow is recorded inactive until one is');
    activeIds = new Set();
  } else {
    activeIds = new Set();
  }

  const workflows = {};
  for (const [id, name] of all) {
    workflows[id] = { name, active: activeIds.has(id) };
  }
  // An id seen only in the active list is still real.
  if (activeText != null) {
    for (const [id, name] of parseWorkflowLines(activeText)) {
      workflows[id] ??= { name, active: true };
    }
  }

  return { workflows, warnings };
}
