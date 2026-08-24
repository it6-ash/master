/**
 * Filesystem and JSON helpers shared by ingest, diff, build and validate.
 *
 * writeJsonIfChanged() is what makes `npm run ingest` idempotent: keys are
 * ordered deterministically, so re-ingesting an unchanged dump produces a
 * byte-identical file and the write is skipped entirely.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
export const abs = (...parts) => path.resolve(ROOT, ...parts);

/** Keys that read best first; everything else is sorted alphabetically. */
const KEY_PRIORITY = [
  'id', 'name', 'title', 'role', 'ip', 'provider', 'server', 'project',
  'status', 'state', 'severity', 'active', 'group', 'noise',
  'specs', 'summary', 'source', 'rule',
];

export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== 'object') return value;

  const keys = Object.keys(value);
  const priority = KEY_PRIORITY.filter((k) => keys.includes(k));
  const others = keys.filter((k) => !priority.includes(k)).sort();

  const out = {};
  for (const k of [...priority, ...others]) out[k] = sortKeysDeep(value[k]);
  return out;
}

export function serializeJson(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

/**
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
export function readJson(p) {
  if (!exists(p)) return { ok: false, error: `file not found: ${rel(p)}` };
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, error: `unreadable: ${e.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e.message}` };
  }
}

/**
 * Write only when the serialized bytes differ.
 * @returns {boolean} true if the file was written
 */
export function writeJsonIfChanged(p, value) {
  const next = serializeJson(value);
  if (exists(p) && fs.readFileSync(p, 'utf8') === next) return false;
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, next, 'utf8');
  return true;
}

export function writeTextIfChanged(p, text) {
  if (exists(p) && fs.readFileSync(p, 'utf8') === text) return false;
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, text, 'utf8');
  return true;
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Files directly inside `dir` matching `filter`, sorted. Missing dir → []. */
export function listFiles(dir, filter = () => true) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && filter(d.name))
    .map((d) => path.join(dir, d.name))
    .sort();
}

/** Immediate subdirectory names, sorted. Missing dir → []. */
export function listDirs(dir) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export const isJson = (name) => name.endsWith('.json');
export const isMarkdown = (name) => name.endsWith('.md');
