#!/usr/bin/env node
/**
 * npm run sync — collect from every server, ingest, rebuild.
 *
 *   npm run sync                    all servers once
 *   npm run sync -- srv1340120      one server
 *   npm run sync -- --every 6h      keep going on an interval
 *   npm run sync -- --dry-run       show the commands, run nothing
 *
 * For each host it runs kw-collect.sh over SSH, pulls the dump into raw/, then
 * runs the normal ingest and build. Nothing new is trusted: the same parser,
 * the same redaction, the same snapshot-and-diff path a hand-pasted dump takes.
 *
 * NOTE ON SCOPE. The brief was explicit that this is not a monitoring tool and
 * does not poll servers. This is a deliberate departure, added on request. Two
 * consequences worth keeping in mind:
 *   - it needs SSH access to production from wherever it runs
 *   - a dashboard that refreshes itself is one nobody reads carefully, so the
 *     "What changed" panel matters more, not less, once this is on a timer
 *
 * Connection details live in config/hosts.json, which is git-ignored. Copy
 * config/hosts.example.json and fill it in. No credential is ever read into
 * the dashboard, and none is written to data/.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

import { ROOT, abs, rel, exists, readJson, ensureDir } from './lib/fsx.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.filter((a) => !a.startsWith('--'));

const everyIndex = args.indexOf('--every');
const everyRaw = everyIndex !== -1 ? args[everyIndex + 1] : null;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (color ? `[${c}m${s}[0m` : s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const dim = (s) => paint('2', s);

/** "6h" -> 21600000. Returns null if unparseable. */
export function parseInterval(input) {
  const m = /^(\d+)\s*(s|m|h|d)?$/i.exec(String(input ?? '').trim());
  if (!m) return null;
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[(m[2] ?? 'm').toLowerCase()];
  const ms = Number(m[1]) * mult;
  return ms >= 60000 ? ms : null; // a sub-minute poll of a production box is a mistake
}

/* ----------------------------------------------------------- host list */

/**
 * Hosts come from config/hosts.json when it exists, otherwise from the IPs
 * already in data/servers.json so a first run needs no configuration beyond
 * a working SSH agent.
 */
export function loadHosts() {
  const configured = readJson(abs('config', 'hosts.json'));
  if (configured.ok) {
    const defaults = configured.value.defaults ?? {};
    return Object.entries(configured.value.hosts ?? {})
      .map(([id, host]) => ({ id, ...defaults, ...host }));
  }

  const servers = readJson(abs('data', 'servers.json'));
  if (!servers.ok) return [];
  return Object.entries(servers.value)
    .filter(([, s]) => s.ip)
    .map(([id, s]) => ({ id, host: s.ip, user: 'root' }));
}

/* -------------------------------------------------------------- runner */

function run(command, argv, { capture = false } = {}) {
  return new Promise((resolve) => {
    if (dryRun) {
      process.stdout.write(`${dim(`  would run: ${command} ${argv.join(' ')}`)}\n`);
      resolve({ code: 0, stdout: '', stderr: '' });
      return;
    }
    const child = spawn(command, argv, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
    }
    child.on('error', (e) => resolve({ code: 1, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const sshArgs = (host) => [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=15',
  ...(host.port ? ['-p', String(host.port)] : []),
  ...(host.key ? ['-i', host.key] : []),
];

/**
 * Loopback is this machine. Running the dashboard ON the estate makes one of
 * the three hosts local, and going out through sshd to reach yourself means
 * the box has to trust its own key and sshd has to accept a root login from
 * itself — two ways to fail at a thing that needs no network at all.
 */
export const isLocal = (host) => ['127.0.0.1', '::1', 'localhost'].includes(String(host.host ?? ''));

/**
 * Push the collector, run it, and bring the dump back. The collector is
 * read-only and redacts at source, so nothing sensitive crosses the wire in
 * the clear beyond what SSH already protects.
 */
async function collect(host) {
  const local = isLocal(host);
  const target = `${host.user ?? 'root'}@${host.host}`;
  const remoteScript = '/root/kw-collect.sh';
  const localScript = abs('kw-collect.sh');

  if (!exists(localScript)) {
    return { ok: false, reason: 'kw-collect.sh is missing from the repo root' };
  }

  process.stdout.write(`${dim(`  → ${local ? 'this machine, no ssh' : target}`)}\n`);

  if (!local) {
    const push = await run('scp', [...sshArgs(host), localScript, `${target}:${remoteScript}`]);
    if (push.code !== 0) return { ok: false, reason: `could not copy the collector (scp exit ${push.code})` };
  }

  const exec = local
    ? await run('bash', [localScript], { capture: true })
    : await run('ssh', [...sshArgs(host), target, `bash ${remoteScript}`], { capture: true });
  if (exec.code !== 0) {
    return { ok: false, reason: `collector failed (exit ${exec.code}) ${exec.stderr.slice(0, 200)}` };
  }

  // The collector prints "Collected: /root/kw-collect-<host>-<stamp>.txt"
  const named = /Collected:\s*(\S+)/.exec(exec.stdout);
  const remoteDump = named ? named[1] : null;
  if (!remoteDump && !dryRun) {
    return { ok: false, reason: 'collector did not report an output path' };
  }

  // Refuse to bring back a dump the collector's own leak check failed.
  if (/FAIL\s+—\s+\d+\s+unredacted/.test(exec.stdout)) {
    return { ok: false, reason: 'the collector reported unredacted secrets; dump left on the server' };
  }

  ensureDir(abs('raw'));
  const localName = remoteDump ? path.basename(remoteDump) : `kw-collect-${host.id}.txt`;
  const destination = abs('raw', localName);

  if (local) {
    if (!dryRun) fs.copyFileSync(remoteDump, destination);
  } else {
    const pull = await run('scp', [...sshArgs(host), `${target}:${remoteDump ?? ''}`, destination]);
    if (pull.code !== 0) return { ok: false, reason: `could not fetch the dump (scp exit ${pull.code})` };
  }

  // Don't leave a pile of estate inventories in /root. On a timer that is four
  // new ones per box per day, each naming every open port and cron credential.
  if (remoteDump && local && !dryRun) fs.rmSync(remoteDump, { force: true });
  else if (remoteDump && !local) await run('ssh', [...sshArgs(host), target, `rm -f ${remoteDump}`]);

  return { ok: true, file: rel(destination) };
}

/**
 * Keep the newest few dumps per host in raw/. They are the re-ingest source, so
 * a handful is worth having; a year of 6-hourly collection is not.
 */
export function pruneRaw(hostId, keep = 5) {
  const dir = abs('raw');
  if (!exists(dir)) return 0;
  const mine = fs.readdirSync(dir)
    .filter((n) => n.startsWith(`kw-collect-${hostId}`) && n.endsWith('.txt'))
    .sort(); // the collector's stamp sorts chronologically
  const doomed = mine.slice(0, Math.max(0, mine.length - keep));
  for (const name of doomed) fs.rmSync(path.join(dir, name), { force: true });
  return doomed.length;
}

/* ---------------------------------------------------------------- pass */

async function once() {
  const hosts = loadHosts().filter((h) => (only.length ? only.includes(h.id) : true));

  if (hosts.length === 0) {
    process.stdout.write(`${red('✗')} No hosts. Add config/hosts.json, or ingest a dump so data/servers.json has an IP.\n`);
    return 1;
  }

  process.stdout.write(`\n${dim(new Date().toISOString().replace('T', ' ').slice(0, 19))} collecting from ${hosts.length} host${hosts.length === 1 ? '' : 's'}\n`);

  let collected = 0;
  for (const host of hosts) {
    process.stdout.write(`${host.id}\n`);
    let result;
    try {
      result = await collect(host);
    } catch (e) {
      result = { ok: false, reason: e.message };
    }
    if (result.ok) {
      collected += 1;
      process.stdout.write(`${green('  ✓')} ${result.file}\n`);
    } else {
      // One unreachable host must not stop the others.
      process.stdout.write(`${yellow('  !')} ${result.reason}\n`);
    }
  }

  if (collected === 0) {
    process.stdout.write(`${yellow('!')} Nothing collected; leaving data/ and dist/ alone.\n`);
    return 1;
  }

  const ingest = await run(process.execPath, [abs('src', 'ingest', 'index.js')]);
  if (ingest.code !== 0) return ingest.code;

  // After ingest, never before: a dump that has not been read yet is not spare.
  if (!dryRun) for (const host of hosts) pruneRaw(host.id);

  const build = await run(process.execPath, [abs('src', 'build.js')]);
  return build.code;
}

/* ------------------------------------------------------------------ CLI */

async function main() {
  if (!everyRaw) {
    process.exit(await once());
  }

  const interval = parseInterval(everyRaw);
  if (!interval) {
    process.stderr.write('--every takes a duration of at least a minute, e.g. 30m, 6h, 1d\n');
    process.exit(2);
  }

  process.stdout.write(`Syncing every ${everyRaw}. Ctrl-C to stop.\n`);
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; process.stdout.write('\nStopped.\n'); process.exit(0); });

  /* eslint-disable no-await-in-loop */
  while (!stopping) {
    try {
      await once();
    } catch (e) {
      process.stdout.write(`${red('✗')} sync failed: ${e.message}\n`);
    }
    await new Promise((r) => { setTimeout(r, interval); });
  }
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(ROOT, 'src', 'sync.js')) main();
