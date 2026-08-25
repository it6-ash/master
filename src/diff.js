#!/usr/bin/env node
/**
 * Snapshot comparison and auto-issue rules (brief §9).
 *
 * Two exports, two consumers:
 *   diffSnapshots(prev, next)  -> change events for the "What changed" panel
 *   autoIssues(servers, wf)    -> source:"auto" issues, regenerated every ingest
 *
 * Run directly (`npm run diff`) it prints the events between the two most
 * recent snapshots of every server.
 */

import path from 'node:path';

import {
  ROOT, abs, exists, readJson, listFiles, listDirs, isJson,
} from './lib/fsx.js';
import { isRedacted } from './lib/redact.js';
import { isoDate } from './lib/units.js';

/* ------------------------------------------------------------- utilities */

const byName = (list, key = 'name') => new Map((list ?? []).map((x) => [x[key], x]));
const portKey = (p) => `${p.proto ?? 'tcp'}/${p.port}`;

const slug = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60) || 'x';

/** Ports that mean "a database is listening here". */
const DB_PORTS = new Map([
  [27017, 'mongodb'], [3306, 'mysql'], [5432, 'postgres'],
  [6379, 'redis'], [1433, 'mssql'], [9200, 'elasticsearch'], [5984, 'couchdb'],
]);
const DB_PROCS = /^(mongod|mysqld|mariadbd|postgres|redis-server|sqlservr)$/;

const isDatabasePort = (p) => DB_PORTS.has(p.port) || DB_PROCS.test(p.proc ?? '');

/* ------------------------------------------------------- change events */

/**
 * @param {object|null} prev previous snapshot record (or null for a first sighting)
 * @param {object} next     newer snapshot record
 * @param {{ server: string, at: string }} ctx
 * @returns {Array<object>} events, newest-snapshot dated
 */
export function diffSnapshots(prev, next, { server, at }) {
  const events = [];
  const push = (type, severity, extra) => events.push({ type, at, severity, server, ...extra });

  if (!prev) return events;

  /* services */
  const prevSvc = byName(prev.services);
  const nextSvc = byName(next.services);
  if (prev.services && next.services) {
    for (const [name, svc] of nextSvc) {
      const before = prevSvc.get(name);
      if (!before) { push('service.appeared', 'info', { name }); continue; }
      if (before.state !== svc.state) {
        if (svc.state === 'failed') push('service.failed', 'high', { name, from: before.state, to: svc.state });
        else if (before.state === 'failed') push('service.recovered', 'info', { name, from: before.state, to: svc.state });
      }
    }
    for (const name of prevSvc.keys()) {
      if (!nextSvc.has(name)) push('service.disappeared', 'medium', { name });
    }
  }

  /* ports */
  if (prev.ports && next.ports) {
    const before = new Map((prev.ports ?? []).map((p) => [portKey(p), p]));
    const after = new Map((next.ports ?? []).map((p) => [portKey(p), p]));
    for (const [key, p] of after) {
      const was = before.get(key);
      if (!was) {
        push('port.appeared', p.exposed && isDatabasePort(p) ? 'critical' : 'info',
          { port: p.port, name: p.proc, to: p.bind });
      } else if (!was.exposed && p.exposed) {
        push('port.exposed', isDatabasePort(p) ? 'critical' : 'high',
          { port: p.port, name: p.proc, from: was.bind, to: p.bind });
      } else if (was.exposed && !p.exposed) {
        push('port.unexposed', 'info', { port: p.port, name: p.proc, from: was.bind, to: p.bind });
      }
    }
    for (const [key, p] of before) {
      if (!after.has(key)) push('port.closed', 'info', { port: p.port, name: p.proc });
    }
  }

  /* containers */
  if (prev.containers && next.containers) {
    const before = byName(prev.containers);
    const after = byName(next.containers);
    for (const [name, c] of after) {
      const was = before.get(name);
      if (!was) push('container.appeared', 'info', { name, to: c.state });
      else if (was.state !== c.state) {
        const bad = ['restarting', 'dead', 'exited'].includes(c.state);
        push('container.state', bad ? 'medium' : 'info', { name, from: was.state, to: c.state });
      }
    }
    for (const name of before.keys()) {
      if (!after.has(name)) push('container.disappeared', 'medium', { name });
    }
  }

  /* disk */
  const from = prev.state?.diskUsedPct;
  const to = next.state?.diskUsedPct;
  if (Number.isInteger(from) && Number.isInteger(to) && from !== to) {
    const delta = Math.abs(to - from);
    if (delta >= 5) push('disk.jump', to > from && to >= 80 ? 'high' : 'info', { from, to });
    if (from < 80 && to >= 80) push('disk.threshold', 'high', { from, to });
  }

  /* kernel and reboot */
  if (prev.state?.kernel && next.state?.kernel && prev.state.kernel !== next.state.kernel) {
    push('kernel.updated', 'info', { from: prev.state.kernel, to: next.state.kernel });
  }
  if (prev.state?.rebootPending === false && next.state?.rebootPending === true) {
    push('reboot.pending', 'medium', {});
  }

  /* firewall */
  if (prev.state?.firewall && next.state?.firewall && prev.state.firewall !== next.state.firewall) {
    push('firewall.changed', next.state.firewall === 'active' ? 'info' : 'critical',
      { from: prev.state.firewall, to: next.state.firewall });
  }

  /* vhosts and certs */
  if (prev.vhosts && next.vhosts) {
    const before = byName(prev.vhosts, 'domain');
    const after = byName(next.vhosts, 'domain');
    for (const [domain, v] of after) {
      const was = before.get(domain);
      if (!was) { push('vhost.appeared', 'info', { domain, to: v.proxyTo }); continue; }
      const wasDays = was.certExpiryDays;
      const nowDays = v.certExpiryDays;
      if (Number.isInteger(wasDays) && Number.isInteger(nowDays) && nowDays > wasDays) {
        push('cert.renewed', 'info', { domain, from: wasDays, to: nowDays, days: nowDays });
      }
    }
    for (const domain of before.keys()) {
      if (!after.has(domain)) push('vhost.disappeared', 'medium', { domain });
    }
  }
  for (const v of next.vhosts ?? []) {
    if (Number.isInteger(v.certExpiryDays) && v.certExpiryDays < 30) {
      push('cert.expiring', v.certExpiryDays < 7 ? 'critical' : 'high',
        { domain: v.domain, days: v.certExpiryDays });
    }
  }

  /* deployment directories */
  if (prev.projects && next.projects) {
    const before = new Set(prev.projects.map((p) => p.path));
    const after = new Set(next.projects.map((p) => p.path));
    for (const p of after) if (!before.has(p)) push('project.appeared', 'info', { name: p });
    for (const p of before) if (!after.has(p)) push('project.disappeared', 'medium', { name: p });
  }

  /* mongo growth */
  for (const [dbName, db] of Object.entries(next.databases ?? {})) {
    const wasDb = prev.databases?.[dbName];
    if (!wasDb) continue;
    const wasColl = byName(wasDb.collections);
    for (const coll of db.collections ?? []) {
      const was = wasColl.get(coll.name);
      if (!was || !Number.isInteger(was.docs) || !Number.isInteger(coll.docs)) continue;
      if (coll.docs !== was.docs) {
        push('db.growth', 'info', {
          name: `${dbName}.${coll.name}`, from: was.docs, to: coll.docs,
        });
      }
    }
  }

  return events;
}

/** Workflow activation changes, from workflows.json history. */
export function diffWorkflows(workflows, { since = null } = {}) {
  const events = [];
  for (const [id, wf] of Object.entries(workflows ?? {})) {
    const history = wf.history ?? [];
    for (let i = 1; i < history.length; i += 1) {
      const entry = history[i];
      if (since && entry.date < since) continue;
      events.push({
        type: entry.active ? 'workflow.activated' : 'workflow.deactivated',
        at: entry.date,
        severity: entry.active ? 'info' : 'medium',
        id,
        name: wf.name,
        server: wf.server,
      });
    }
    if (history.length === 1 && (!since || history[0].date >= since)) {
      events.push({
        type: 'workflow.appeared', at: history[0].date, severity: 'info',
        id, name: wf.name, server: wf.server,
      });
    }
    if (wf.missingSince && (!since || wf.missingSince >= since)) {
      events.push({
        type: 'workflow.disappeared', at: wf.missingSince, severity: 'medium',
        id, name: wf.name, server: wf.server,
      });
    }
  }
  return events;
}

/** Servers whose data has gone stale (§10.3). */
export function stalenessEvents(servers, today) {
  const events = [];
  for (const [id, server] of Object.entries(servers ?? {})) {
    if (!server.lastIngest) continue;
    const days = Math.floor((new Date(today) - new Date(server.lastIngest)) / 86400000);
    if (days > 7) {
      events.push({
        type: 'server.stale', at: today, severity: days > 30 ? 'high' : 'medium',
        server: id, days, note: `last ingested ${days} days ago`,
      });
    }
  }
  return events;
}

/* --------------------------------------------------------- auto issues */

/**
 * Regenerate every source:"auto" issue from current state. Ids are stable
 * (rule + subject) so re-running updates rather than duplicates.
 *
 * @param {Record<string, object>} servers
 * @param {{ today: string, previous?: Array }} ctx
 * @returns {Array<object>}
 */
export function autoIssues(servers, { today, previous = [] } = {}) {
  const priorOpened = new Map(
    previous.filter((i) => i.source === 'auto').map((i) => [i.id, i.opened]),
  );
  const issues = [];

  const add = (rule, severity, server, subject, title, body, evidence) => {
    const id = `auto-${rule}-${slug(server)}${subject ? `-${slug(subject)}` : ''}`;
    issues.push({
      id,
      severity,
      title,
      body,
      project: null,
      server,
      source: 'auto',
      rule,
      ...(evidence ? { evidence } : {}),
      opened: priorOpened.get(id) ?? today,
      resolved: null,
    });
  };

  for (const [id, s] of Object.entries(servers)) {
    /* database port bound to the world */
    for (const p of s.ports ?? []) {
      if (!p.exposed || !isDatabasePort(p)) continue;
      const engine = DB_PORTS.get(p.port) ?? p.proc;
      add('db-port-exposed', 'critical', id, `${p.proto}-${p.port}`,
        `${engine} on ${id} is reachable from the internet`,
        `Port ${p.port} is bound to ${p.bind} rather than 127.0.0.1. Anything that can route to ${s.ip ?? id} can attempt to connect to the database directly.`,
        `${p.proto}/${p.port} bind=${p.bind} proc=${p.proc ?? 'unknown'}`);
    }

    /* firewall off */
    if (s.state?.firewall === 'inactive') {
      add('ufw-inactive', 'critical', id, null,
        `ufw is inactive on ${id}`,
        `Every listening port on this host is reachable from anywhere that can route to it.`,
        'ufw status: inactive');
    }

    /* failed units */
    for (const svc of s.services ?? []) {
      if (svc.state !== 'failed') continue;
      add('unit-failed', 'high', id, svc.name,
        `${svc.name} has failed on ${id}`,
        `${svc.desc ?? svc.name} is in a failed state.${svc.port ? ` It should be serving port ${svc.port}.` : ''}`,
        `systemctl --failed: ${svc.name}.service`);
    }

    /* certificates */
    for (const v of s.vhosts ?? []) {
      if (!Number.isInteger(v.certExpiryDays) || v.certExpiryDays >= 30) continue;
      add('cert-expiring', v.certExpiryDays < 7 ? 'critical' : 'high', id, v.domain,
        `Certificate for ${v.domain} expires in ${v.certExpiryDays} days`,
        `The certificate${v.certName && v.certName !== v.domain ? ` "${v.certName}"` : ''} covering ${v.domain} expires in ${v.certExpiryDays} days.`,
        `certbot: ${v.certName ?? v.domain} — ${v.certExpiryDays} days`);
    }

    /* stale kernel */
    const kernels = s.state?.kernelInstalled ?? [];
    const newest = kernels[kernels.length - 1];
    if (newest && s.state?.kernel && newest !== s.state.kernel) {
      add('kernel-stale', 'medium', id, null,
        `${id} is running an older kernel than the one installed`,
        `Running ${s.state.kernel}, but ${newest} is installed. A reboot is needed to pick it up.`,
        `running=${s.state.kernel} newest=${newest}`);
    }

    /* disk */
    if (Number.isInteger(s.state?.diskUsedPct) && s.state.diskUsedPct > 80) {
      add('disk-high', 'high', id, null,
        `${id} disk is ${s.state.diskUsedPct}% full`,
        `${s.state.diskUsed ?? '?'} of ${s.state.diskTotal ?? '?'} used.`,
        `df /: ${s.state.diskUsedPct}%`);
    }

    /* containers stuck in Created */
    for (const c of s.containers ?? []) {
      if (c.state !== 'created' || !Number.isInteger(c.ageDays) || c.ageDays <= 7) continue;
      add('container-stuck-created', 'low', id, c.name,
        `Container ${c.name} has been in Created state for ${c.ageDays} days`,
        `It was created but never started. Either it is dead weight, or something expects it to be running.`,
        `docker ps -a: ${c.name} — Created, ${c.ageDays}d`);
    }

    /* credentials in cron */
    for (const c of s.cron ?? []) {
      if (!c.hasSecret && !isRedacted(c.cmd)) continue;
      add('cron-secret', 'high', id, `${c.user ?? 'root'}-${c.schedule ?? ''}-${(c.cmd ?? '').slice(0, 24)}`,
        `A scheduled job on ${id} carries a credential on its command line`,
        `The ${c.user ?? 'root'} crontab entry "${c.schedule}" passes a secret as an argument, which makes it visible in the process table and in shell history. Move it to an environment file with 0600 permissions.`,
        `${c.user ?? 'root'}: ${c.schedule} ${(c.cmd ?? '').slice(0, 90)}`);
    }

    /* sites-enabled entries that are not symlinks */
    for (const site of s.web?.sitesEnabled ?? []) {
      if (site.isSymlink !== false) continue;
      add('sites-enabled-not-symlink', 'medium', id, site.name,
        `${site.name} in sites-enabled is a file, not a symlink`,
        `nginx loads it all the same, so it is live configuration that no longer tracks anything in sites-available.`,
        `/etc/nginx/sites-enabled/${site.name}`);
    }
  }

  return issues.sort((a, b) => {
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    return (rank[a.severity] - rank[b.severity]) || a.id.localeCompare(b.id);
  });
}

/* ------------------------------------------------------------------ CLI */

/** Snapshot files for a server, oldest first. */
export function snapshotsFor(server) {
  const dir = abs('data', 'snapshots', server);
  return listFiles(dir, isJson).sort();
}

function main() {
  const servers = listDirs(abs('data', 'snapshots'));
  if (servers.length === 0) {
    process.stdout.write('No snapshots yet. Run `npm run ingest` first.\n');
    process.exit(0);
  }

  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (c, s) => (color ? `[${c}m${s}[0m` : s);
  const dim = (s) => paint('2', s);
  const SEV = { critical: '31', high: '33', medium: '36', low: '2', info: '2' };

  let total = 0;
  for (const server of servers) {
    const files = snapshotsFor(server);
    if (files.length < 2) {
      process.stdout.write(`${dim(`${server}: ${files.length} snapshot — need two to compare`)}\n`);
      continue;
    }
    const prev = readJson(files[files.length - 2]);
    const next = readJson(files[files.length - 1]);
    if (!prev.ok || !next.ok) continue;

    const at = isoDate(next.value.capturedAt ?? next.value.takenAt) ?? 'unknown';
    const events = diffSnapshots(prev.value.record, next.value.record, { server, at });
    total += events.length;

    process.stdout.write(`\n${server}  ${dim(`${path.basename(files[files.length - 2])} → ${path.basename(files[files.length - 1])}`)}\n`);
    if (events.length === 0) process.stdout.write(`  ${dim('no changes')}\n`);
    for (const e of events) {
      const detail = [e.name, e.domain, e.port, e.from != null ? `${e.from} → ${e.to}` : null]
        .filter((x) => x != null && x !== '').join(' ');
      process.stdout.write(`  ${paint(SEV[e.severity] ?? '2', e.type.padEnd(22))} ${detail}\n`);
    }
  }

  const wf = readJson(abs('data', 'workflows.json'));
  if (wf.ok) {
    const events = diffWorkflows(wf.value);
    const changes = events.filter((e) => e.type !== 'workflow.appeared');
    if (changes.length) {
      process.stdout.write(`\nworkflows\n`);
      for (const e of changes.slice(-20)) {
        process.stdout.write(`  ${paint(SEV[e.severity] ?? '2', e.type.padEnd(22))} ${e.at}  ${e.name}\n`);
      }
      total += changes.length;
    }
  }

  process.stdout.write(`\n${total} change event${total === 1 ? '' : 's'}\n`);
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(ROOT, 'src', 'diff.js')) main();
