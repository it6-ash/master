/**
 * Parser for MongoDB collection listings, in any of the shapes this estate
 * produces:
 *
 *   customerChats | 26437 docs          the hand-run query in the brief §8c
 *   Yamini	customerChats	27368        the tab-separated form kw-collect.sh emits
 *   customerChats: 26437
 *
 * When no database name is present the caller supplies one (`db`), defaulting
 * to Yamini — the only Mongo database in the estate.
 */

export const PARSER = 'mongo-stats';
export const PARSER_VERSION = '1.0.0';

const NAME_RE = /^[A-Za-z_][\w.-]*$/;

/**
 * @param {string} text
 * @param {{ db?: string }} [opts]
 * @returns {{ databases: Record<string, {engine: string, collections: Array}>, warnings: string[] }}
 */
export function parseMongoStats(text, { db = 'Yamini' } = {}) {
  const warnings = [];
  /** @type {Record<string, Map<string, number|null>>} */
  const byDb = new Map();

  const add = (dbName, collection, docs) => {
    if (!byDb.has(dbName)) byDb.set(dbName, new Map());
    byDb.get(dbName).set(collection, docs);
  };

  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (/^mongo_error\b/.test(line)) {
      warnings.push(`mongo query reported an error: ${line.slice(0, 120)}`);
      continue;
    }

    // db \t collection \t count
    const tabbed = line.split('\t').map((c) => c.trim()).filter(Boolean);
    if (tabbed.length === 3 && NAME_RE.test(tabbed[0]) && NAME_RE.test(tabbed[1]) && /^\d+$/.test(tabbed[2])) {
      add(tabbed[0], tabbed[1], Number(tabbed[2]));
      continue;
    }

    // collection | 26437 docs   /   collection: 26437   /   collection  26437 docs
    // The name is matched by its own charset so a greedy \S+ cannot swallow
    // the ":" separator and then fail the name check.
    const m = /^([A-Za-z_][\w.-]*)\s*[|:]?\s+(\d[\d,]*)\s*(?:docs?|documents?)?\s*$/.exec(line);
    if (m) {
      add(db, m[1], Number(m[2].replace(/,/g, '')));
      continue;
    }

    if (/\d/.test(line)) warnings.push(`unrecognised line: ${line.slice(0, 80)}`);
  }

  const databases = {};
  for (const [dbName, collections] of byDb) {
    databases[dbName] = {
      engine: 'mongodb',
      collections: [...collections.entries()]
        .map(([name, docs]) => ({ name, ...(docs == null ? {} : { docs }) }))
        .sort((a, b) => (b.docs ?? 0) - (a.docs ?? 0)),
    };
  }

  if (Object.keys(databases).length === 0) warnings.push('no collection counts found');

  return { databases, warnings };
}
