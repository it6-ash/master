/**
 * Size, duration and date helpers for the ingest parsers.
 *
 * Every function returns null rather than throwing on input it does not
 * understand — parsers must survive a truncated or reformatted dump.
 */

const BINARY = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 };
const DECIMAL = { b: 1, k: 1000, m: 1000 ** 2, g: 1000 ** 3, t: 1000 ** 4, p: 1000 ** 5 };

/**
 * "15Gi" -> 16106127360   (Gi/Mi/Ki: 1024-based, `free -h`)
 * "193G" -> 207232401408  (bare G: 1024-based, `df -h`)
 * "8.992GB" -> 8992000000 (GB: 1000-based, docker)
 * "0B", "0" -> 0
 */
export function parseSize(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (s === '' || s === '-') return null;

  const m = /^(-?[\d.]+)\s*([KMGTP]i?B?|B)?$/i.exec(s);
  if (!m) return null;

  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;

  const suffix = (m[2] ?? 'B').toLowerCase();
  const unit = suffix[0];
  // "gb" is decimal; "gi", "gib" and bare "g" are binary.
  const table = suffix.length === 2 && suffix[1] === 'b' ? DECIMAL : BINARY;

  const mult = table[unit];
  return mult === undefined ? null : Math.round(value * mult);
}

/** "19%" -> 19, "19" -> 19, "-" -> null */
export function parsePercent(input) {
  if (input == null) return null;
  const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(String(input).trim());
  if (!m) return null;
  return Math.round(Number(m[1]));
}

/**
 * Parses the `uptime` line.
 * " 12:03:33 up 115 days, 20:31,  1 user,  load average: 0.71, 0.79, 0.58"
 *   -> { uptime: "115 days", uptimeSeconds: 9987060, load: [0.71, 0.79, 0.58] }
 * Also handles "up 3 weeks", "up 5 min", "up 1:23", "up 2 days,  3:04".
 */
export function parseUptime(line) {
  if (!line) return {};
  const out = {};

  const load = /load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(line);
  if (load) out.load = [Number(load[1]), Number(load[2]), Number(load[3])];

  const up = /\bup\s+(.+?)(?:,\s+\d+\s+users?\b|$)/.exec(line);
  if (!up) return out;

  const raw = up[1].trim().replace(/,\s*$/, '');
  let seconds = 0;
  let matched = false;

  for (const [, n, unit] of raw.matchAll(/(\d+)\s*(week|day|hour|min|sec)/gi)) {
    const mult = { week: 604800, day: 86400, hour: 3600, min: 60, sec: 1 }[unit.toLowerCase()];
    seconds += Number(n) * mult;
    matched = true;
  }

  // A bare "H:MM" tail means hours:minutes.
  const hm = /(?:^|,\s*)(\d+):(\d{2})\s*$/.exec(raw);
  if (hm) {
    seconds += Number(hm[1]) * 3600 + Number(hm[2]) * 60;
    matched = true;
  }

  if (matched) out.uptimeSeconds = seconds;

  // Prefer the coarse human form the dashboard wants: "115 days".
  const coarse = /(\d+\s*(?:weeks?|days?))/i.exec(raw);
  out.uptime = coarse ? coarse[1].replace(/\s+/g, ' ') : raw;

  return out;
}

/** "2026-11-17 05:54:01+00:00" -> Date, or null */
export function parseDate(input) {
  if (!input) return null;
  const s = String(input).trim().replace(' ', 'T');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days from `from` to `to`, or null. */
export function daysBetween(from, to) {
  if (!from || !to) return null;
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

/** "2026-08-24T12:03:33Z" -> "2026-08-24" */
export function isoDate(input) {
  const d = input instanceof Date ? input : parseDate(input);
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Filename-safe snapshot stamp: "2026-08-24T1203" */
export function snapshotStamp(input) {
  const d = input instanceof Date ? input : parseDate(input);
  if (!d) return null;
  const iso = d.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}
