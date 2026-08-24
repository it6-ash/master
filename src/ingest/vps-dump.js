/**
 * Parser for kw-collect.sh output (schema 2.0).
 *
 *   ===MANIFEST===
 *   ===SECTION:NAME===
 *   ---subsection---
 *
 * Contract, from the brief §8a — robustness beats completeness:
 *   - never throw; a section that fails to parse becomes a warning and is skipped
 *   - a section that is ABSENT leaves that part of the record undefined, so the
 *     merge step leaves the previous value alone rather than nulling it
 *   - identify the server from hostnamectl, never from the filename
 *   - tolerate ANSI colour, bracketed-paste artefacts and interleaved prompts
 *   - never emit a secret: the whole record goes through redactDeep() on the
 *     way out, even though kw-collect.sh redacts at source. Belt and braces.
 */

import { redactDeep, redactString, isRedacted } from '../lib/redact.js';
import {
  parseSize, parsePercent, parseUptime, parseDate, daysBetween, isoDate,
} from '../lib/units.js';

export const PARSER = 'vps-dump';
export const PARSER_VERSION = '2.0.0';

/** Section names may contain digits — N8N, CPU_MEM_DISK. */
const SECTION_RE = /^===SECTION:([A-Z0-9_]+)===\s*$/;
const SUBSECTION_RE = /^---([a-z0-9_]+)---\s*$/;
const MANIFEST_RE = /^===MANIFEST===\s*$/;
const END_RE = /^===END===\s*$/;

/**
 * @param {string} text raw dump
 * @param {{ sourceFile?: string }} [opts]
 * @returns {{
 *   ok: boolean, server: string|null, record: object,
 *   workflows: Record<string, {name: string, active: boolean}>,
 *   manifest: object, capturedAt: string|null,
 *   warnings: string[], secretKinds: string[]
 * }}
 */
export function parseVpsDump(text, { sourceFile = null } = {}) {
  const warnings = [];
  const record = {};
  let workflows = {};

  const lines = sanitize(String(text ?? ''));
  const { manifest, sections } = sectionize(lines);

  if (Object.keys(sections).length === 0) {
    warnings.push('no ===SECTION:...=== headers found — this does not look like a kw-collect.sh dump');
  }
  if (manifest.schema && manifest.schema !== '2.0') {
    warnings.push(`dump declares collector schema ${manifest.schema}; this parser targets 2.0`);
  }

  const capturedAt = manifest.collected_at ?? null;
  const collectedDate = parseDate(capturedAt) ?? null;

  /** Run one section parser, converting any throw into a warning. */
  const run = (name, fn) => {
    const section = sections[name];
    if (!section) {
      warnings.push(`section ${name} absent — leaving those fields untouched`);
      return;
    }
    try {
      fn(section);
    } catch (e) {
      warnings.push(`section ${name} failed to parse (${e.message}) — skipped`);
    }
  };

  run('HOST', (s) => parseHost(s, record));
  run('CPU_MEM_DISK', (s) => parseCpuMemDisk(s, record));
  run('NETWORK', (s) => parseNetwork(s, record));
  run('SSH', (s) => parseSsh(s, record));
  run('SERVICES', (s) => parseServices(s, record, warnings));
  run('DOCKER', (s) => parseDocker(s, record, collectedDate));
  run('WEB', (s) => parseWeb(s, record, collectedDate, warnings));
  run('DATABASES', (s) => parseDatabases(s, record, warnings));
  run('N8N', (s) => { workflows = parseN8n(s, record); });
  run('PROJECTS', (s) => parseProjects(s, record));
  run('CRON', (s) => parseCron(s, record));
  run('LOGS', (s) => parseLogs(s, record));
  run('PACKAGES', (s) => parsePackages(s, record));

  // Identify the server from hostnamectl, falling back to the manifest.
  let server = record.name ?? null;
  if (!server && manifest.hostname) {
    server = String(manifest.hostname).split('.')[0];
    record.name = server;
    warnings.push('hostnamectl gave no Static hostname — fell back to the manifest hostname');
  }
  if (!server) {
    warnings.push('could not determine which server this dump belongs to');
  }

  // Timers are collected under SERVICES but belong with cron. Fold them in
  // here rather than in parseCron, so an absent CRON section cannot strand
  // the internal field on the record.
  if (record._timers) {
    record.cron = [...(record.cron ?? []), ...record._timers];
    delete record._timers;
  }

  correlateServicePorts(record);
  deriveRebootPending(record);

  if (capturedAt) record.lastIngest = capturedAt;
  if (sourceFile) record.sourceFile = sourceFile;

  // Belt and braces: the collector redacts, and so do we.
  const { value: safeRecord, kinds } = redactDeep(record);
  const { value: safeWorkflows } = redactDeep(workflows);

  return {
    ok: server != null,
    server,
    record: safeRecord,
    workflows: safeWorkflows,
    manifest,
    capturedAt,
    warnings,
    secretKinds: kinds,
  };
}

/* ------------------------------------------------------------ tokenising */

/**
 * Strip the noise §8a warns about: ANSI colour, bracketed-paste markers in
 * both escape and caret notation, CRs, and interleaved shell prompts.
 */
function sanitize(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\[[0-9]*~/g, '')
    .replace(/\^\[\[[0-9]+~/g, '')
    .split('\n')
    .filter((line) => !/^[a-z_][\w.-]*@[\w.-]+:[^$#]*[$#]\s/.test(line));
}

/**
 * @returns {{ manifest: object, sections: Record<string, Record<string, string[]>> }}
 * Every section carries a `_head` bucket for lines before its first subsection
 * — DATABASES and N8N both put real content there.
 */
function sectionize(lines) {
  const manifest = {};
  const sections = {};

  let inManifest = false;
  let section = null;
  let sub = '_head';

  for (const line of lines) {
    if (MANIFEST_RE.test(line)) { inManifest = true; section = null; continue; }
    if (END_RE.test(line)) { inManifest = false; section = null; continue; }

    const secMatch = SECTION_RE.exec(line);
    if (secMatch) {
      inManifest = false;
      section = secMatch[1];
      sub = '_head';
      sections[section] ??= {};
      sections[section]._head ??= [];
      continue;
    }

    if (inManifest) {
      const kv = /^([a-z_]+)=(.*)$/.exec(line.trim());
      if (kv) manifest[kv[1]] = kv[2];
      continue;
    }

    if (!section) continue;

    const subMatch = SUBSECTION_RE.exec(line);
    if (subMatch) {
      sub = subMatch[1];
      // `version` appears in both DOCKER and WEB; sections are already scoped.
      sections[section][sub] ??= [];
      continue;
    }

    sections[section][sub] ??= [];
    sections[section][sub].push(line);
  }

  return { manifest, sections };
}

/** Non-empty, non-comment lines of a subsection. */
const body = (section, name) => (section[name] ?? [])
  .filter((l) => l.trim() !== '' && !/^\s*#/.test(l));

/** All lines including blanks, for layout-sensitive blocks. */
const rawBody = (section, name) => section[name] ?? [];

const first = (section, name) => body(section, name)[0]?.trim() ?? null;

function keyValues(lines, separator = ':') {
  const out = {};
  for (const line of lines) {
    const idx = line.indexOf(separator);
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

const setIf = (target, key, value) => {
  if (value !== null && value !== undefined && value !== '') target[key] = value;
};

/* ------------------------------------------------------------------ HOST */

function parseHost(section, record) {
  const state = (record.state ??= {});
  const specs = (record.specs ??= {});

  const host = keyValues(body(section, 'hostnamectl'));
  setIf(record, 'name', host['Static hostname']);
  setIf(state, 'os', host['Operating System']);
  setIf(specs, 'arch', host.Architecture);
  setIf(specs, 'virt', host.Virtualization);

  // "Kernel: Linux 6.8.0-110-generic"
  if (host.Kernel) setIf(state, 'kernel', host.Kernel.replace(/^Linux\s+/, ''));

  // uname -a: field 3 is the release
  const uname = first(section, 'uname');
  if (uname && !state.kernel) setIf(state, 'kernel', uname.split(/\s+/)[2]);
  if (uname && !record.name) setIf(record, 'name', uname.split(/\s+/)[1]);

  Object.assign(state, parseUptime(first(section, 'uptime')));

  if (!state.os) {
    const os = keyValues(body(section, 'os_release'), '=');
    const name = os.NAME?.replace(/"/g, '');
    const version = os.VERSION?.replace(/"/g, '');
    if (name) setIf(state, 'os', [name, version].filter(Boolean).join(' '));
  }
}

/* --------------------------------------------------------- CPU_MEM_DISK */

function parseCpuMemDisk(section, record) {
  const state = (record.state ??= {});
  const specs = (record.specs ??= {});

  const nproc = Number(first(section, 'nproc'));
  if (Number.isInteger(nproc) && nproc > 0) specs.cpu = nproc;

  const cpu = keyValues(body(section, 'cpu_model'));
  setIf(specs, 'cpuModel', cpu['Model name']);
  if (!specs.cpu && cpu['CPU(s)']) {
    const n = Number(cpu['CPU(s)']);
    if (Number.isInteger(n) && n > 0) specs.cpu = n;
  }

  // free -h
  for (const line of body(section, 'memory')) {
    const mem = /^Mem:\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line);
    if (mem) {
      setIf(specs, 'ram', mem[1]);
      setIf(specs, 'ramBytes', parseSize(mem[1]));
      setIf(state, 'memTotal', mem[1]);
      setIf(state, 'memUsed', mem[2]);
      setIf(state, 'memAvailable', mem[6]);
      const total = parseSize(mem[1]);
      const used = parseSize(mem[2]);
      if (total > 0 && used != null) state.memUsedPct = Math.round((used / total) * 100);
    }
    const swap = /^Swap:\s+(\S+)\s+(\S+)/.exec(line);
    if (swap) {
      setIf(state, 'swapTotal', swap[1]);
      setIf(state, 'swapUsed', swap[2]);
    }
  }

  // df -h. Docker overlay mounts repeat the root filesystem; they are noise.
  const mounts = [];
  for (const line of body(section, 'disk')) {
    if (/^Filesystem\s/.test(line)) continue;
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S.*)$/.exec(line.trim());
    if (!m) continue;
    const [, fs, size, used, avail, usePct, mount] = m;
    if (fs === 'overlay' || mount.startsWith('/var/lib/docker')) continue;

    const entry = { mount: mount.trim(), fs, size, used, avail };
    const pct = parsePercent(usePct);
    if (pct !== null) entry.usePct = pct;
    mounts.push(entry);
  }
  if (mounts.length) state.mounts = mounts;

  const root = mounts.find((m) => m.mount === '/');
  if (root) {
    setIf(specs, 'disk', root.size);
    setIf(specs, 'diskBytes', parseSize(root.size));
    setIf(state, 'diskTotal', root.size);
    setIf(state, 'diskUsed', root.used);
    setIf(state, 'diskAvail', root.avail);
    if (root.usePct !== undefined) state.diskUsedPct = root.usePct;
  }

  const storage = {};
  const topDirs = parseSizeList(body(section, 'top_dirs'));
  const bigFiles = parseSizeList(body(section, 'big_files'));
  if (topDirs.length) storage.topDirs = topDirs.slice(0, 25);
  if (bigFiles.length) storage.bigFiles = bigFiles.slice(0, 25);
  if (Object.keys(storage).length) record.storage = storage;
}

/** "3.5G\t/var/log/mongodb/mongod.log" -> { path, size, sizeBytes } */
function parseSizeList(lines) {
  const out = [];
  for (const line of lines) {
    const m = /^(\S+)[\t ]+(\S.*)$/.exec(line.trim());
    if (!m) continue;
    const size = parseSize(m[1]);
    if (size === null) continue;
    out.push({ path: m[2].trim(), size: m[1], sizeBytes: size });
  }
  return out;
}

/* --------------------------------------------------------------- NETWORK */

function parseNetwork(section, record) {
  // ip -br a: pick the first global IPv4 that is not loopback or a docker bridge
  for (const line of body(section, 'interfaces')) {
    const [iface, , ...addrs] = line.trim().split(/\s+/);
    if (!iface || iface === 'lo' || /^(docker|br-|veth)/.test(iface)) continue;
    for (const addr of addrs) {
      const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/\d+$/.exec(addr);
      if (m) { record.ip = m[1]; break; }
    }
    if (record.ip) break;
  }

  const ports = parseListening(body(section, 'listening'));
  if (ports.length) record.ports = ports;

  const ufw = parseUfw(rawBody(section, 'ufw'));
  if (ufw) {
    const state = (record.state ??= {});
    setIf(state, 'firewall', ufw.firewall);
    setIf(state, 'firewallDefault', ufw.default);
    if (ufw.rules.length) state.firewallRules = ufw.rules;
  }
}

/**
 * ss -tulnp. Local address takes many shapes:
 *   0.0.0.0:8001   127.0.0.1:5678   [::]:22   [::1]:5432   *:55569
 *   127.0.0.53%lo:53
 */
function parseListening(lines) {
  const seen = new Map();

  for (const line of lines) {
    if (/^Netid\s/.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;

    const [netid, , , , local] = cols;
    const proto = netid === 'udp' ? 'udp' : 'tcp';

    const split = /^(.*):(\d+)$/.exec(local);
    if (!split) continue;
    const bind = split[1].replace(/%\w+$/, '');
    const port = Number(split[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

    const entry = {
      port,
      proto,
      bind,
      exposed: bind === '0.0.0.0' || bind === '*' || bind === '[::]' || bind === '::',
    };

    const proc = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    if (proc) {
      entry.proc = proc[1];
      entry.pid = Number(proc[2]);
    }

    // Collapse IPv4/IPv6 duplicates of one socket ([::]:22 next to 0.0.0.0:22),
    // but keep genuinely different binds — systemd-resolved really does listen
    // on both 127.0.0.53 and 127.0.0.54.
    const canonicalBind = { '[::]': '0.0.0.0', '::': '0.0.0.0', '*': '0.0.0.0', '[::1]': '127.0.0.1' }[bind] ?? bind;
    const key = `${proto}/${port}/${canonicalBind}`;
    const prior = seen.get(key);
    if (!prior || (entry.exposed && !prior.exposed)) seen.set(key, entry);
  }

  return [...seen.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

function parseUfw(lines) {
  const text = lines.join('\n');
  if (/ufw not installed/i.test(text)) return { firewall: 'unknown', rules: [] };

  const status = /^Status:\s*(\w+)/m.exec(text);
  const dflt = /^Default:\s*(.+)$/m.exec(text);

  const rules = [];
  let inTable = false;
  for (const line of lines) {
    if (/^--\s+-+/.test(line.trim())) { inTable = true; continue; }
    if (!inTable) continue;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (/\(v6\)/.test(trimmed)) continue; // the v6 rows mirror the v4 ones
    rules.push(trimmed.replace(/\s{2,}/g, ' '));
  }

  return {
    firewall: status ? (status[1].toLowerCase() === 'active' ? 'active' : 'inactive') : 'unknown',
    default: dflt ? dflt[1].trim() : null,
    rules,
  };
}

/* ------------------------------------------------------------------- SSH */

function parseSsh(section, record) {
  const eff = keyValues(body(section, 'effective'), ' ');
  const ssh = {};

  if (eff.port) {
    const n = Number(eff.port);
    if (Number.isInteger(n)) ssh.port = n;
  }
  const bool = (v) => (v === 'yes' ? true : v === 'no' ? false : undefined);
  if (bool(eff.permitrootlogin) !== undefined) ssh.permitRootLogin = bool(eff.permitrootlogin);
  if (bool(eff.passwordauthentication) !== undefined) ssh.passwordAuthentication = bool(eff.passwordauthentication);
  if (bool(eff.pubkeyauthentication) !== undefined) ssh.pubkeyAuthentication = bool(eff.pubkeyauthentication);

  const failed = /failed_password_current_log=(\d+)/.exec(body(section, 'failed_count').join('\n'));
  if (failed) ssh.failedPasswords = Number(failed[1]);

  const attackers = [];
  for (const line of body(section, 'top_attackers')) {
    const m = /^\s*(\d+)\s+(\d{1,3}(?:\.\d{1,3}){3})\s*$/.exec(line);
    if (m) attackers.push({ ip: m[2], count: Number(m[1]) });
  }
  if (attackers.length) ssh.topAttackers = attackers.slice(0, 10);

  if (Object.keys(ssh).length) record.ssh = ssh;
}

/* -------------------------------------------------------------- SERVICES */

function parseServices(section, record, warnings) {
  /** @type {Map<string, object>} */
  const services = new Map();
  const get = (name) => {
    if (!services.has(name)) services.set(name, { name });
    return services.get(name);
  };

  // systemctl list-units --state=running: NAME LOAD ACTIVE SUB DESCRIPTION…
  for (const line of body(section, 'running')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || !cols[0].endsWith('.service')) continue;
    const svc = get(cols[0].replace(/\.service$/, ''));
    svc.state = 'running';
    svc.sub = cols[3];
    const desc = cols.slice(4).join(' ').trim();
    if (desc) svc.desc = desc;
  }

  for (const line of body(section, 'enabled')) {
    const cols = line.trim().split(/\s+/);
    if (!cols[0]?.endsWith('.service')) continue;
    const svc = get(cols[0].replace(/\.service$/, ''));
    svc.enabled = 'enabled';
    svc.state ??= 'inactive';
  }

  // systemctl --failed rows are prefixed with a status bullet.
  for (const line of body(section, 'failed')) {
    const cols = line.replace(/^[●*x✕✗\s]+/u, '').trim().split(/\s+/);
    if (!cols[0]?.endsWith('.service')) continue;
    const svc = get(cols[0].replace(/\.service$/, ''));
    svc.state = 'failed';
    svc.sub = cols[3] ?? 'failed';
    const desc = cols.slice(4).join(' ').trim();
    if (desc && !svc.desc) svc.desc = desc;
  }

  // ==unit:name.service== blocks of Key=Value
  let current = null;
  for (const line of rawBody(section, 'unit_details')) {
    const header = /^==unit:(.+?)==\s*$/.exec(line.trim());
    if (header) {
      current = header[1].endsWith('.service') ? header[1].replace(/\.service$/, '') : header[1];
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (!kv) continue;

    const svc = get(current);
    const [, key, value] = kv;
    if (key === 'Description' && !svc.desc) svc.desc = value;
    if (key === 'ExecStart') svc.execStart ??= value;
    if (key === 'User') svc.user ??= value;
    if (key === 'WorkingDirectory') svc.workingDir ??= value;
    if (key === 'EnvironmentFile') svc.envFile ??= value;
    if (key === 'Restart') svc.restart ??= value;
  }

  for (const svc of services.values()) {
    svc.state ??= 'unknown';
    const port = portFromExecStart(svc.execStart);
    if (port !== null) svc.port = port;
    delete svc.execStart; // an ExecStart can carry credentials; the port is what we want
  }

  if (services.size) {
    record.services = [...services.values()].sort((a, b) => a.name.localeCompare(b.name));
  } else {
    warnings.push('SERVICES section produced no units');
  }

  const timers = [];
  for (const line of body(section, 'timers')) {
    const m = /(\S+\.timer)\s+(\S+\.service)\s*$/.exec(line.trim());
    if (!m) continue;
    const next = line.trim().split(/\s{2,}/)[0];
    timers.push({
      unit: m[1],
      // Give timers the same shape as crontab rows: whatever renders `cmd`
      // should not have to special-case them.
      cmd: m[2],
      source: 'systemd-timer',
      schedule: next && next !== '-' ? `next: ${next}` : 'inactive',
      hasSecret: false,
    });
  }
  if (timers.length) record._timers = timers; // folded into cron by parseCron
}

/** `--port 8001`, `--bind 127.0.0.1:8001`, `-b 127.0.0.1:8200`, `-p 3100`, `http.server 8899` */
function portFromExecStart(exec) {
  if (!exec) return null;
  const patterns = [
    /--port[= ](\d{2,5})\b/,
    /--bind[= ](?:[\d.]+|localhost|\[::\]):(\d{2,5})\b/,
    /\s-b\s+(?:[\d.]+|localhost):(\d{2,5})\b/,
    /\s-p\s+(\d{2,5})\b/,
    /http\.server\s+(\d{2,5})\b/,
    /--host[= ]\S+\s+--port[= ](\d{2,5})\b/,
  ];
  for (const re of patterns) {
    const m = re.exec(exec);
    if (m) {
      const port = Number(m[1]);
      if (port >= 1 && port <= 65535) return port;
    }
  }
  return null;
}

/** Fill in service ports we could not read from ExecStart, using ss output. */
function correlateServicePorts(record) {
  if (!record.services || !record.ports) return;
  for (const svc of record.services) {
    if (svc.port != null) continue;
    const hit = record.ports.find((p) => p.proc && (p.proc === svc.name || svc.name.startsWith(p.proc)));
    if (hit) svc.port = hit.port;
  }
}

/* ---------------------------------------------------------------- DOCKER */

function parseDocker(section, record, collectedDate) {
  if (body(section, '_head').some((l) => /docker not installed/i.test(l))) return;

  const docker = {};
  setIf(docker, 'version', first(section, 'version'));

  const containers = [];
  for (const line of body(section, 'containers')) {
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const [name, image, state, status, ports, createdAt] = cols;
    const entry = { name: name.trim(), state: normalizeContainerState(state) };
    setIf(entry, 'image', image?.trim());
    setIf(entry, 'status', status?.trim());
    setIf(entry, 'ports', ports?.trim());
    setIf(entry, 'createdAt', createdAt?.trim());

    const created = parseDate(createdAt?.replace(' +0000 UTC', 'Z').replace(' ', 'T'));
    const age = daysBetween(created, collectedDate);
    if (age !== null && age >= 0) entry.ageDays = age;

    containers.push(entry);
  }
  if (containers.length) {
    record.containers = containers;
    docker.containersTotal = containers.length;
    docker.containersRunning = containers.filter((c) => c.state === 'running').length;
  }

  const images = body(section, 'images');
  if (images.length) docker.images = images.length;

  const volumes = body(section, 'volumes');
  if (volumes.length) docker.volumes = volumes.length;

  const orphans = [];
  for (const line of body(section, 'volume_users')) {
    const [volume, users] = line.split('\t');
    if (users?.trim() === 'ORPHAN') orphans.push(volume.trim());
  }
  if (orphans.length) docker.orphanVolumes = orphans;

  // docker system df: TYPE TOTAL ACTIVE SIZE RECLAIMABLE
  // Its TOTAL column beats counting lines — `docker images` hides dangling
  // layers that `system df` still counts.
  const usage = {};
  for (const line of body(section, 'system_df')) {
    const m = /^(Images|Containers|Local Volumes|Build Cache)\s+(\d+)\s+\d+\s+(\S+)\s+(\S+)/.exec(line.trim());
    if (!m) continue;
    const key = { Images: 'images', Containers: 'containers', 'Local Volumes': 'volumes', 'Build Cache': 'buildCache' }[m[1]];
    usage[key] = m[3];
    if (m[1] === 'Images') { usage.reclaimable = m[4]; docker.images = Number(m[2]); }
    if (m[1] === 'Local Volumes') docker.volumes = Number(m[2]);
  }
  if (Object.keys(usage).length) docker.diskUsage = usage;

  const compose = [];
  for (const line of body(section, 'compose')) {
    if (/^NAME\s+STATUS/.test(line.trim())) continue;
    const m = /^(\S+)\s+(\S+)\s+(\S.*)$/.exec(line.trim());
    if (m) compose.push({ name: m[1], status: m[2], configFile: m[3].trim() });
  }
  if (compose.length) docker.compose = compose;

  if (Object.keys(docker).length) record.docker = docker;
}

function normalizeContainerState(state) {
  const s = String(state ?? '').trim().toLowerCase();
  const known = ['running', 'exited', 'created', 'restarting', 'paused', 'dead', 'removing'];
  return known.includes(s) ? s : 'unknown';
}

/* ------------------------------------------------------------------- WEB */

function parseWeb(section, record, collectedDate, warnings) {
  const web = {};
  const vhosts = new Map();

  const nginxVersion = first(section, 'version');
  if (nginxVersion && /nginx/i.test(nginxVersion)) web.servers = ['nginx'];
  if (body(section, '_head').some((l) => /nginx not installed/i.test(l))) web.servers = [];

  parseNginxVhosts(body(section, 'vhosts'), vhosts);
  parseCerts(body(section, 'certs'), vhosts, collectedDate, warnings);
  parseCloudflared(body(section, 'cloudflared'), vhosts, web);

  const sites = parseSitesEnabled(rawBody(section, 'sites_enabled'), body(section, 'not_symlinks'));
  if (sites.length) web.sitesEnabled = sites;

  if (vhosts.size) record.vhosts = [...vhosts.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  if (Object.keys(web).length) record.web = web;
}

/**
 * `nginx -T | grep` gives a FLAT stream of directives with no block structure.
 * Reconstruct ownership by walking in order: a `server_name` opens the current
 * block; `listen` seen before any `server_name` is held until one appears.
 */
function parseNginxVhosts(lines, vhosts) {
  let current = [];
  let pendingListen = [];

  const touch = (domain) => {
    const key = domain.toLowerCase();
    if (!vhosts.has(key)) vhosts.set(key, { domain, source: 'nginx' });
    return vhosts.get(key);
  };
  const applyListen = (domains, directive) => {
    for (const d of domains) {
      const v = touch(d);
      if (/\bssl\b/.test(directive)) v.ssl = true;
    }
  };

  for (const raw of lines) {
    const line = raw.trim().replace(/;.*$/, '').trim();
    if (line === '') continue;

    const name = /^server_name\s+(.+)$/.exec(line);
    if (name) {
      current = name[1].split(/\s+/).filter((d) => d && d !== '_');
      current.forEach(touch);
      for (const directive of pendingListen) applyListen(current, directive);
      pendingListen = [];
      continue;
    }

    const listen = /^listen\s+(.+)$/.exec(line);
    if (listen) {
      if (current.length) applyListen(current, listen[1]);
      else pendingListen.push(listen[1]);
      continue;
    }

    const proxy = /^proxy_pass\s+(\S+)$/.exec(line);
    if (proxy && current.length) {
      const upstream = proxy[1].replace(/^https?:\/\//, '');
      for (const d of current) {
        const v = touch(d);
        v.proxyTo ??= upstream;
      }
      continue;
    }

    const root = /^root\s+(\S+)$/.exec(line);
    if (root && current.length) {
      for (const d of current) touch(d).root ??= root[1];
    }
  }
}

function parseCerts(lines, vhosts, collectedDate, warnings) {
  if (lines.some((l) => /certbot not available/i.test(l))) return;

  let name = null;
  let domains = [];

  const flush = (days) => {
    for (const domain of domains) {
      const key = domain.toLowerCase();
      if (!vhosts.has(key)) vhosts.set(key, { domain, source: 'nginx' });
      const v = vhosts.get(key);
      v.certName = name;
      v.ssl = true;
      if (days !== null) v.certExpiryDays = days;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();

    const certName = /^Certificate Name:\s*(\S+)/.exec(line);
    if (certName) { name = certName[1]; domains = []; continue; }

    const domainLine = /^Domains:\s*(.+)$/.exec(line);
    if (domainLine) { domains = domainLine[1].split(/\s+/).filter(Boolean); continue; }

    const expiry = /^Expiry Date:\s*(\S+\s+\S+)\s*(?:\(([^)]*)\))?/.exec(line);
    if (!expiry) continue;

    // Prefer certbot's own "(VALID: 84 days)"; fall back to computing it.
    let days = null;
    const stated = /(-?\d+)\s*days?/.exec(expiry[2] ?? '');
    if (stated) days = Number(stated[1]);
    else {
      const expiryDate = parseDate(expiry[1]);
      days = daysBetween(collectedDate, expiryDate);
      if (days === null) warnings.push(`could not read expiry date for certificate ${name ?? '?'}`);
    }
    flush(days);
  }
}

function parseCloudflared(lines, vhosts, web) {
  if (lines.some((l) => /no cloudflared config/i.test(l))) return;

  let hostname = null;
  for (const raw of lines) {
    const line = raw.trim();
    const h = /^-\s*hostname:\s*(\S+)/.exec(line);
    if (h) { hostname = h[1]; continue; }
    const s = /^service:\s*(\S+)/.exec(line);
    if (s && hostname) {
      const key = hostname.toLowerCase();
      const v = vhosts.get(key) ?? { domain: hostname };
      // A hostname served through the tunnel does NOT reach nginx.
      v.source = 'cloudflared';
      v.proxyTo ??= s[1].replace(/^https?:\/\//, '');
      vhosts.set(key, v);
      hostname = null;
    }
  }
  if ([...vhosts.values()].some((v) => v.source === 'cloudflared')) {
    web.servers = [...new Set([...(web.servers ?? []), 'cloudflared'])];
  }
}

function parseSitesEnabled(lsLines, notSymlinks) {
  const sites = [];
  const plainFiles = new Set(notSymlinks.map((p) => p.trim().split('/').pop()).filter(Boolean));

  for (const raw of lsLines) {
    const line = raw.trim();
    if (line === '' || /^total\s/.test(line)) continue;

    const m = /^([dlrwx-]{10})\S*\s+\d+\s+\S+\s+\S+\s+\d+\s+.{6,12}\s+(.+)$/.exec(line);
    if (!m) continue;

    const isLink = m[1][0] === 'l';
    let name = m[2].trim();
    let target = null;
    if (isLink && name.includes(' -> ')) {
      [name, target] = name.split(' -> ').map((s) => s.trim());
    }
    if (name === '.' || name === '..') continue;

    const entry = { name, isSymlink: isLink };
    if (target) entry.target = target;
    sites.push(entry);
  }

  // Anything `find -type f` reported is definitively not a symlink.
  for (const name of plainFiles) {
    const existing = sites.find((s) => s.name === name);
    if (existing) existing.isSymlink = false;
    else sites.push({ name, isSymlink: false });
  }

  return sites.sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------- DATABASES */

function parseDatabases(section, record, warnings) {
  const databases = {};

  // `NAME=active` lines, where a following bare "absent" means the unit is
  // not installed (the collector's `is-active || echo absent` prints both).
  const head = body(section, '_head');
  const engines = {};
  head.forEach((line, i) => {
    const kv = /^(\S+)=(\S+)$/.exec(line.trim());
    if (!kv) return;
    const absent = head[i + 1]?.trim() === 'absent';
    engines[kv[1]] = absent ? 'absent' : kv[2];
  });
  if (Object.keys(engines).length) record.databaseEngines = engines;

  for (const line of body(section, 'postgres_dbs')) {
    const name = line.split('|')[0].trim();
    if (!name || /^template[01]$/.test(name)) continue;
    databases[name] = { engine: 'postgres' };
  }

  for (const line of body(section, 'mongo_collections')) {
    const cols = line.split('\t').map((c) => c.trim());
    if (cols[0] === 'mongo_error') {
      warnings.push(`mongo collection query failed: ${redactString(cols[1] ?? '').text}`);
      continue;
    }
    if (cols.length < 3) continue;
    const [db, collection, docs] = cols;
    const n = Number(docs);
    databases[db] ??= { engine: 'mongodb', collections: [] };
    databases[db].collections ??= [];
    databases[db].collections.push({
      name: collection,
      ...(Number.isInteger(n) ? { docs: n } : {}),
    });
  }

  for (const db of Object.values(databases)) {
    db.collections?.sort((a, b) => (b.docs ?? 0) - (a.docs ?? 0));
  }

  if (Object.keys(databases).length) record.databases = databases;
}

/* ------------------------------------------------------------------- N8N */

function parseN8n(section, record) {
  const head = body(section, '_head');
  if (head.some((l) => /no n8n container/i.test(l))) return {};

  const n8n = {};
  const container = /^container=(\S+)/.exec(head.find((l) => l.startsWith('container=')) ?? '');
  if (container) n8n.container = container[1];

  const parseList = (name) => {
    const out = new Map();
    for (const line of body(section, name)) {
      const idx = line.indexOf('|');
      if (idx <= 0) continue;
      const id = line.slice(0, idx).trim();
      const wfName = line.slice(idx + 1).trim();
      if (/^[A-Za-z0-9_-]{8,36}$/.test(id)) out.set(id, wfName);
    }
    return out;
  };

  const all = parseList('all_workflows');
  const active = parseList('active_workflows');

  /** @type {Record<string, {name: string, active: boolean}>} */
  const workflows = {};
  for (const [id, name] of all) workflows[id] = { name, active: active.has(id) };
  // An id that only shows up in the active list is still a real workflow.
  for (const [id, name] of active) workflows[id] ??= { name, active: true };

  if (all.size) n8n.workflowCount = all.size;
  if (active.size) n8n.activeCount = active.size;

  const dbSize = Number(first(section, 'db_size'));
  if (Number.isInteger(dbSize) && dbSize > 0) n8n.dbSizeBytes = dbSize;

  if (Object.keys(n8n).length) record.n8n = n8n;
  return workflows;
}

/* -------------------------------------------------------------- PROJECTS */

function parseProjects(section, record) {
  /** @type {Map<string, object>} */
  const projects = new Map();
  const get = (path) => {
    if (!projects.has(path)) projects.set(path, { path });
    return projects.get(path);
  };

  for (const { path, size, sizeBytes } of parseSizeList(body(section, 'sizes'))) {
    Object.assign(get(path), { size, sizeBytes });
  }

  for (const line of body(section, 'git_repos')) {
    const path = line.trim();
    if (path.startsWith('/')) get(path).git = true;
  }

  for (const line of body(section, 'git_remotes')) {
    const [path, remote] = line.split('\t');
    if (!path?.trim().startsWith('/')) continue;
    const entry = get(path.trim());
    entry.git = true;
    if (remote?.trim() && remote.trim() !== 'none') entry.remote = remote.trim();
  }

  for (const line of body(section, 'env_files')) {
    const file = line.trim();
    if (!file.startsWith('/')) continue;
    const dir = file.slice(0, file.lastIndexOf('/'));
    // Attribute the .env to its project directory when we know it.
    const owner = [...projects.keys()].find((p) => dir === p || dir.startsWith(`${p}/`));
    get(owner ?? dir).hasEnv = true;
  }

  if (projects.size) {
    record.projects = [...projects.values()]
      .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  }

  const stale = body(section, 'stale_files').map((l) => l.trim()).filter((l) => l.startsWith('/'));
  if (stale.length) record.staleFiles = stale;
}

/* ------------------------------------------------------------------ CRON */

function parseCron(section, record) {
  const entries = [];
  const seen = new Set();

  const push = (user, schedule, cmd, source) => {
    const { text, kinds } = redactString(cmd);
    const key = `${user}|${schedule}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);

    // kw-collect.sh redacts at source, so a credential-bearing line often
    // arrives already sanitised and our own pass finds nothing to do. The line
    // still describes a secret, so flag it from the marker.
    const secretKinds = kinds.length ? kinds : (isRedacted(text) ? ['collector-redacted'] : []);

    const entry = { user, schedule, cmd: text, source, hasSecret: secretKinds.length > 0 };
    if (secretKinds.length) entry.secretKinds = secretKinds;
    entries.push(entry);
  };

  const CRON_LINE = /^([@\S]+(?:\s+\S+){4})\s+(.+)$/;
  const AT_LINE = /^(@\w+)\s+(.+)$/;

  const readCrontab = (lines, defaultUser, source) => {
    let user = defaultUser;
    for (const raw of lines) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;

      const userHeader = /^==user:(.+)==$/.exec(line);
      if (userHeader) { user = userHeader[1]; continue; }

      const fileHeader = /^==(\/\S+)==$/.exec(line);
      if (fileHeader) { user = null; continue; }

      if (/^[A-Z_]+=/.test(line)) continue; // SHELL=, PATH=, MAILTO=

      const at = AT_LINE.exec(line);
      if (at) { push(user ?? 'root', at[1], at[2], source); continue; }

      const m = CRON_LINE.exec(line);
      if (!m) continue;

      let schedule = m[1];
      let rest = m[2];
      // /etc/cron.d lines carry a user field between schedule and command.
      if (source === 'cron.d') {
        const withUser = /^(\S+)\s+(.+)$/.exec(rest);
        if (withUser && /^[a-z_][\w-]*$/.test(withUser[1])) {
          push(withUser[1], schedule, withUser[2], source);
          continue;
        }
      }
      push(user ?? 'root', schedule, rest, source);
    }
  };

  readCrontab(body(section, 'root_crontab'), 'root', 'crontab');
  readCrontab(body(section, 'user_crontabs'), 'root', 'crontab');
  readCrontab(body(section, 'cron_d'), null, 'cron.d');

  if (entries.length) record.cron = entries;
}

/* ------------------------------------------------------------------ LOGS */

function parseLogs(section, record) {
  const logs = {};

  const journal = /take up\s+(\S+?)\s+in the file system/.exec(body(section, 'journal_size').join(' '));
  if (journal) logs.journalSize = journal[1];

  const varLog = parseSizeList(body(section, 'var_log_total'))[0];
  if (varLog) logs.varLogTotal = varLog.size;

  const largest = [];
  for (const line of body(section, 'largest_logs')) {
    if (/^total\s/.test(line.trim())) continue;
    const m = /^[dlrwx-]{10}\S*\s+\d+\s+\S+\s+\S+\s+(\S+)\s+.{6,12}\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    const entry = { path: `/var/log/${m[2]}`, size: m[1] };
    const bytes = parseSize(m[1]);
    if (bytes !== null) entry.sizeBytes = bytes;
    largest.push(entry);
  }

  // `find -size +100M` results are the ones that actually matter.
  for (const { path, size, sizeBytes } of parseSizeList(body(section, 'oversized'))) {
    const existing = largest.find((l) => l.path === path);
    if (existing) Object.assign(existing, { size, sizeBytes });
    else largest.unshift({ path, size, sizeBytes });
  }

  if (largest.length) {
    logs.largest = largest.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)).slice(0, 12);
  }

  const errors = body(section, 'recent_errors').length;
  if (errors) logs.recentErrors = errors;

  if (Object.keys(logs).length) record.logs = logs;
}

/* -------------------------------------------------------------- PACKAGES */

function parsePackages(section, record) {
  const state = (record.state ??= {});

  const running = first(section, 'running_kernel');
  if (running) state.kernel = running;

  const installed = body(section, 'installed_kernels')
    .map((l) => l.trim())
    .filter((l) => /^linux-image-\d/.test(l))
    .map((l) => l.replace(/^linux-image-/, ''))
    .sort(compareKernelVersions);
  if (installed.length) state.kernelInstalled = installed;

  const reboot = body(section, 'reboot_required').join(' ');
  if (/restart required/i.test(reboot)) state.rebootPending = true;
  else if (/^\s*no\s*$/i.test(reboot)) state.rebootPending = false;

  const packages = {};
  const upgradable = Number(first(section, 'upgradable'));
  if (Number.isInteger(upgradable)) packages.upgradable = upgradable;
  const aptCache = parseSizeList(body(section, 'apt_cache'))[0];
  if (aptCache) packages.aptCache = aptCache.size;
  if (Object.keys(packages).length) record.packages = packages;
}

/** "6.8.0-110-generic" < "6.8.0-138-generic" */
function compareKernelVersions(a, b) {
  const parts = (s) => (s.match(/\d+/g) ?? []).map(Number);
  const pa = parts(a); const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

/** A newer installed kernel than the running one means a reboot is pending. */
function deriveRebootPending(record) {
  const state = record.state;
  if (!state?.kernel || !state.kernelInstalled?.length) return;
  const newest = state.kernelInstalled[state.kernelInstalled.length - 1];
  if (compareKernelVersions(newest, state.kernel) > 0) state.rebootPending = true;
}

/** Convenience for callers that only want the date part of the capture time. */
export const dumpDate = (result) => isoDate(result.capturedAt);
