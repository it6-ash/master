/**
 * What was IN the items, not just how many there were.
 *
 * Execution analytics answers "5,240 items went through Fetch Leads". It
 * cannot answer "which upload bucket did they go to" or "how many distinct
 * people did we talk to", because those are properties of the item payloads
 * rather than of the run. Those payloads are already in the execution detail
 * the collector fetches — this file reads them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PRIVACY IS THE DESIGN CONSTRAINT HERE, NOT A FOOTNOTE.
 *
 * The Yamini workflows carry WhatsApp conversations with real customers:
 * phone numbers, names, message text. The estate dashboard was readable by
 * anyone who resolved the hostname until very recently. So:
 *
 *   - message text and free-form content are NEVER extracted. There is no
 *     mode that stores them, deliberately, so there is no flag to get wrong.
 *   - an identifier dimension is HASHED by default. A salted SHA-256 truncated
 *     to 12 hex characters is enough to count distinct people and to tell a
 *     returning contact from a new one, and is not enough to recover the
 *     number. The salt lives in the environment, never in data/.
 *   - `mode: "group"` keeps raw values and is for LOW-CARDINALITY, NON-PERSONAL
 *     things — a bucket id, a campaign name, a status, an intent label. It
 *     refuses anything that looks like a phone number or an email.
 *   - every dimension is capped: top-N values kept, the rest folded into a
 *     count of "other", so a mistake cannot turn into an unbounded dump of
 *     customer data in data/runs.
 * ────────────────────────────────────────────────────────────────────────────
 */

import crypto from 'node:crypto';

/** Values that are personal on sight. `group` mode refuses them outright. */
const PERSONAL_RE = [
  /\b\d{7,15}\b/,                                   // a bare phone-shaped number
  /^\+?\d[\d\s-]{6,}$/,                             // formatted phone
  /[^\s@]+@[^\s@]+\.[^\s@]+/,                       // email
  /\b\d{12}\b/,                                     // aadhaar-shaped
];

export const looksPersonal = (value) => {
  const s = String(value ?? '');
  return PERSONAL_RE.some((re) => re.test(s));
};

/** Top-N values kept per dimension per execution. The rest become `other`. */
export const MAX_VALUES = 40;
/** A single value longer than this is not a label, it is content. */
const MAX_LABEL = 60;

/**
 * Stable pseudonym for an identifier.
 *
 * Salted, so the same number produces the same token within this estate and a
 * different one anywhere else — which is what makes "is this a returning
 * contact" answerable without making "whose number is this" answerable.
 *
 * The salt is an environment variable. With none set the dimension is skipped
 * rather than hashed with a constant, because an unsalted hash of a ten-digit
 * phone number is reversible by anyone with a laptop and an afternoon.
 */
export function pseudonym(value, salt) {
  if (!salt) return null;
  return crypto.createHash('sha256').update(`${salt}:${String(value)}`).digest('hex').slice(0, 12);
}

/** `a.b.c` out of an item's json, without evaluating anything. */
export function pluck(json, path) {
  let cursor = json;
  for (const key of String(path).split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * Every item a node emitted, flattened across runs and output branches.
 * @returns {object[]} the `json` of each item
 */
export function itemsOf(runData, node) {
  const runs = runData?.[node];
  if (!Array.isArray(runs)) return [];
  const out = [];
  for (const run of runs) {
    for (const branch of run?.data?.main ?? []) {
      if (!Array.isArray(branch)) continue;
      for (const item of branch) if (item && typeof item.json === 'object') out.push(item.json);
    }
  }
  return out;
}

/**
 * One dimension's tally for one execution.
 *
 * @param {object} runData
 * @param {{node: string, field: string, mode?: 'group'|'distinct', label?: string}} dim
 * @param {{salt?: string}} opts
 * @returns {{ values?: Record<string, number>, distinct?: number, tokens?: string[],
 *             missing: number, total: number, refused?: string } | null}
 */
export function tally(runData, dim, { salt = null } = {}) {
  const items = itemsOf(runData, dim.node);
  if (!items.length) return null;

  const mode = dim.mode === 'distinct' ? 'distinct' : 'group';
  let missing = 0;
  const counts = new Map();

  for (const json of items) {
    const raw = pluck(json, dim.field);
    if (raw === undefined || raw === null || raw === '') { missing += 1; continue; }
    if (typeof raw === 'object') { missing += 1; continue; }

    const value = String(raw).trim();
    if (!value) { missing += 1; continue; }

    if (mode === 'distinct') {
      const token = pseudonym(value, salt);
      // No salt, no pseudonym, no tally. Hashing a ten-digit number with a
      // constant is not anonymisation.
      if (!token) return { refused: 'no $KW_DIMENSION_SALT is set, so identifiers cannot be pseudonymised', missing, total: items.length };
      counts.set(token, (counts.get(token) ?? 0) + 1);
      continue;
    }

    // group mode: raw values are kept, so they must not be personal.
    if (looksPersonal(value)) {
      return {
        refused: `"${dim.field}" on ${dim.node} holds values that look personal (a phone number, an email).`
          + ' Use mode "distinct" to count people without storing who they are.',
        missing,
        total: items.length,
      };
    }
    if (value.length > MAX_LABEL) { missing += 1; continue; } // content, not a label
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  if (!counts.size) return { missing, total: items.length, values: {} };

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const kept = sorted.slice(0, MAX_VALUES);
  const other = sorted.slice(MAX_VALUES).reduce((t, [, n]) => t + n, 0);

  if (mode === 'distinct') {
    return {
      // Exact for THIS execution. The cap below does not affect it.
      distinct: counts.size,
      // Tokens are kept so "returning or new" can be answered across
      // executions — but only while there are few enough to hold. 5,000
      // pseudonyms is 60 KB per execution, which is not a price worth paying
      // to avoid saying "at least".
      //
      // When the cap bites, the tokens are dropped ENTIRELY rather than
      // truncated: a partial union silently reports the cap as the answer,
      // and "40 distinct contacts" when the real figure is 5,263 is a wrong
      // number presented as a right one. An absent union is visibly absent.
      ...(counts.size <= MAX_VALUES
        ? { tokens: [...counts.keys()], repeat: sorted.filter(([, n]) => n > 1).length }
        : { tooManyToUnion: true }),
      missing,
      total: items.length,
    };
  }

  const values = Object.fromEntries(kept);
  if (other > 0) values['(other)'] = other;
  return { values, missing, total: items.length };
}

/**
 * Every configured dimension for one execution.
 * @returns {Record<string, object>} keyed by the dimension's label
 */
export function tallyAll(runData, dimensions = [], opts = {}) {
  const out = {};
  for (const dim of dimensions) {
    if (!dim?.node || !dim?.field) continue;
    const got = tally(runData, dim, opts);
    if (got) out[dim.label ?? `${dim.node}.${dim.field}`] = got;
  }
  return Object.keys(out).length ? out : null;
}

/* ------------------------------------------------------------ rollup */

/**
 * Fold per-execution tallies into one, for a window.
 *
 * Distinct counts do NOT sum: the same contact appearing in six executions is
 * one person, not six. That is what the token list is for — it is unioned, and
 * the cardinality of the union is the answer.
 */
export function rollup(tallies) {
  const out = {};
  for (const tally_ of tallies) {
    for (const [label, got] of Object.entries(tally_ ?? {})) {
      const into = (out[label] ??= {
        values: {}, tokens: new Set(), missing: 0, total: 0, refused: null,
        peakDistinct: 0, runs: 0, unionable: true,
      });
      if (got.refused) { into.refused = got.refused; continue; }
      into.missing += got.missing ?? 0;
      into.total += got.total ?? 0;
      into.runs += 1;
      for (const [value, n] of Object.entries(got.values ?? {})) {
        into.values[value] = (into.values[value] ?? 0) + n;
      }
      if (Number.isFinite(got.distinct)) into.peakDistinct = Math.max(into.peakDistinct, got.distinct);
      // One execution too big to union poisons the whole window's union: the
      // result would be a floor dressed up as a count.
      if (got.tooManyToUnion) into.unionable = false;
      for (const token of got.tokens ?? []) into.tokens.add(token);
      if (Number.isFinite(got.repeat)) into.repeatSeen = (into.repeatSeen ?? 0) + got.repeat;
    }
  }

  for (const entry of Object.values(out)) {
    // A cross-execution unique count only when every execution in the window
    // was small enough to hold its pseudonyms. Otherwise the per-execution
    // peak is reported instead, which is exact and does not pretend to be
    // something it is not.
    if (entry.unionable && entry.tokens.size) entry.distinct = entry.tokens.size;
    else if (entry.peakDistinct) entry.peakOnly = entry.peakDistinct;
    delete entry.tokens;
    delete entry.peakDistinct;
    delete entry.unionable;
    if (!Object.keys(entry.values).length) delete entry.values;
  }
  return out;
}

/* -------------------------------------------------------- discovery */

/**
 * Which fields a node actually emits, and how varied each one is — so a
 * dimension can be configured from what is there rather than from a guess.
 *
 * Returns SHAPE ONLY: field names, how often they are present, how many
 * distinct values, and whether the values look personal. No value is ever
 * returned, which is what makes it safe to run against live customer data.
 */
export function describeFields(runData, node, { sample = 200 } = {}) {
  const items = itemsOf(runData, node).slice(0, sample);
  if (!items.length) return null;

  const fields = new Map();
  const walk = (json, prefix = '') => {
    for (const [key, value] of Object.entries(json ?? {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // One level of nesting is plenty; deeper is usually a payload dump.
        if (!prefix) walk(value, path);
        continue;
      }
      const entry = fields.get(path) ?? { present: 0, distinct: new Set(), personal: false, long: 0, type: typeof value };
      entry.present += 1;
      const s = String(value ?? '');
      if (s.length > MAX_LABEL) entry.long += 1;
      else entry.distinct.add(s);
      if (looksPersonal(s)) entry.personal = true;
      fields.set(path, entry);
    }
  };
  for (const json of items) walk(json);

  return [...fields.entries()].map(([field, e]) => ({
    field,
    type: e.type,
    presentPct: Math.round((e.present / items.length) * 100),
    distinct: e.distinct.size + (e.long ? 1 : 0),
    personal: e.personal,
    mostlyLong: e.long > e.present / 2,
    // The recommendation, which is the useful part of this output.
    suggest: e.personal ? 'distinct'
      : e.long > e.present / 2 ? 'skip — looks like content, not a label'
        : e.distinct.size <= MAX_VALUES ? 'group'
          : 'distinct',
  })).sort((a, b) => b.presentPct - a.presentPct || a.field.localeCompare(b.field));
}
