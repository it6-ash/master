import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseVpsDump } from '../src/ingest/vps-dump.js';
import { SchemaRegistry } from '../src/lib/json-schema.js';
import { scanDeep, isRedacted } from '../src/lib/redact.js';
import { abs, readText, readJson, listFiles, isJson } from '../src/lib/fsx.js';

const FIXTURES = {
  srv1340120: 'test/fixtures/kw-collect-srv1340120-2026-08-24T1203.txt',
  srv1870078: 'test/fixtures/kw-collect-srv1870078-2026-08-24T1204.txt',
  srv1900820: 'test/fixtures/kw-collect-srv1900820-2026-08-24T1214.txt',
};

const cache = new Map();
function parse(id) {
  if (!cache.has(id)) {
    cache.set(id, parseVpsDump(readText(abs(FIXTURES[id])), { sourceFile: FIXTURES[id] }));
  }
  return cache.get(id);
}

const registry = new SchemaRegistry();
for (const file of listFiles(abs('schema'), isJson)) registry.add(readJson(file).value);

/* ------------------------------------------------------------ all dumps */

test('all three real dumps parse with no warnings and satisfy the schema', () => {
  for (const id of Object.keys(FIXTURES)) {
    const result = parse(id);
    assert.equal(result.server, id, 'server identified from hostnamectl, not the filename');
    assert.deepEqual(result.warnings, [], `${id} produced warnings`);

    const errors = registry.validate('servers.schema.json', { [result.server]: result.record });
    assert.deepEqual(errors.map((e) => `${e.path} ${e.message}`), [], `${id} failed the schema`);
  }
});

test('no dump ever yields a credential-shaped string', () => {
  for (const id of Object.keys(FIXTURES)) {
    const result = parse(id);
    assert.deepEqual(scanDeep(result.record), [], `${id} record leaked`);
    assert.deepEqual(scanDeep(result.workflows), [], `${id} workflows leaked`);
  }
});

/* -------------------------------------------------------- srv1340120 */

test('host, specs and state', () => {
  const { record: r, capturedAt } = parse('srv1340120');
  assert.equal(capturedAt, '2026-08-24T12:03:33Z');
  assert.equal(r.ip, '72.62.228.194', 'eth0, not a docker bridge');
  assert.equal(r.state.os, 'Ubuntu 24.04.4 LTS');
  assert.equal(r.state.kernel, '6.8.0-110-generic');
  assert.equal(r.state.uptime, '115 days');
  assert.equal(r.state.uptimeSeconds, 115 * 86400 + 20 * 3600 + 31 * 60);
  assert.deepEqual(r.state.load, [0.71, 0.79, 0.58]);

  assert.equal(r.specs.cpu, 4);
  assert.equal(r.specs.cpuModel, 'AMD EPYC 7543P 32-Core Processor');
  assert.equal(r.specs.ram, '15Gi');
  assert.equal(r.specs.disk, '193G');
});

test('disk comes from / and ignores the docker overlay mounts', () => {
  const { record: r } = parse('srv1340120');
  assert.equal(r.state.diskUsedPct, 19);
  assert.equal(r.state.diskUsed, '35G');
  assert.deepEqual(r.state.mounts.map((m) => m.mount), ['/', '/boot', '/boot/efi']);
});

test('firewall', () => {
  const { record: r } = parse('srv1340120');
  assert.equal(r.state.firewall, 'active');
  assert.match(r.state.firewallDefault, /^deny \(incoming\)/);
  assert.ok(r.state.firewallRules.includes('8100/tcp DENY IN Anywhere'));
  assert.ok(!r.state.firewallRules.some((x) => x.includes('(v6)')), 'v6 rows mirror v4 and are dropped');
});

test('kernel: running is older than newest installed, so a reboot is pending', () => {
  const { record: r } = parse('srv1340120');
  assert.deepEqual(r.state.kernelInstalled, ['6.8.0-110-generic', '6.8.0-138-generic']);
  assert.equal(r.state.rebootPending, true);
});

test('listening ports: bind, process, and what counts as exposed', () => {
  const { record: r } = parse('srv1340120');
  const byPort = (p, proto = 'tcp') => r.ports.find((x) => x.port === p && x.proto === proto);

  const mongo = byPort(27017);
  assert.equal(mongo.bind, '127.0.0.1');
  assert.equal(mongo.exposed, false, 'mongod is loopback-only — the §9 critical rule must NOT fire');
  assert.equal(mongo.proc, 'mongod');

  assert.equal(byPort(8002).exposed, true);
  assert.equal(byPort(8002).proc, 'uvicorn');
  assert.equal(byPort(443).proc, 'nginx');

  const wildcard = byPort(55569, 'udp');
  assert.equal(wildcard.bind, '*');
  assert.equal(wildcard.exposed, true);

  // 127.0.0.53%lo:53 — the interface suffix must not corrupt the bind address
  assert.ok(r.ports.some((p) => p.port === 53 && p.bind === '127.0.0.53'));
});

test('services: running, enabled, failed, and ports read from ExecStart', () => {
  const { record: r } = parse('srv1340120');
  const svc = (name) => r.services.find((s) => s.name === name);

  assert.deepEqual(
    r.services.filter((s) => s.state === 'failed').map((s) => s.name).sort(),
    ['fastapi_app', 'lead-api'],
  );

  assert.equal(svc('dashboard2').state, 'running');
  assert.equal(svc('dashboard2').desc, 'LeadQ Dashboard V2');
  assert.equal(svc('dashboard2').port, 8002, '--port 8002');
  assert.equal(svc('kwatch').port, 8050, '--bind 127.0.0.1:8050');
  assert.equal(svc('kwsite').port, 8200, '-b 127.0.0.1:8200');
  assert.equal(svc('kw-gbt-web').port, 3100, '-p 3100');
  assert.equal(svc('media-server').port, 8899, 'python3 -m http.server 8899');

  assert.equal(svc('kw-gbt-api').user, 'claude-deploy');
  assert.equal(svc('kw-gbt-api').envFile, '/etc/kw-gbt/api.env');
  assert.ok(!('execStart' in svc('kw-gbt-api')), 'ExecStart is dropped — it can carry credentials');
});

test('containers, including the two that are not healthy', () => {
  const { record: r } = parse('srv1340120');
  const c = (name) => r.containers.find((x) => x.name === name);

  assert.equal(r.containers.length, 8);
  assert.equal(r.docker.containersRunning, 6);

  assert.equal(c('n8n-traefik-1').state, 'created');
  assert.ok(c('n8n-traefik-1').ageDays > 7, 'stuck in Created for >7 days — §9 low issue');
  assert.equal(c('traefik-iyg2-traefik-1').state, 'restarting');
  assert.equal(c('n8n-n8n-1').ports, '127.0.0.1:5678->5678/tcp');
});

test('docker counts come from system df, not from counting lines', () => {
  const { record: r } = parse('srv1340120');
  assert.equal(r.docker.images, 10, 'docker images lists 9; system df counts 10');
  assert.equal(r.docker.volumes, 4);
  assert.equal(r.docker.diskUsage.reclaimable, '6.731GB');
  assert.equal(r.docker.compose.find((x) => x.name === 'traefik-iyg2').status, 'restarting(1)');
});

test('vhosts are reconstructed from flat nginx -T grep output', () => {
  const { record: r } = parse('srv1340120');
  const v = (domain) => r.vhosts.find((x) => x.domain.toLowerCase() === domain);

  // proxy_pass appears AFTER two server_name lines for this vhost
  assert.equal(v('leadq.co.in').proxyTo, '127.0.0.1:8001');
  assert.equal(v('leadq.co.in').ssl, true);
  // a `listen 80` that precedes its server_name must still attach
  assert.equal(v('overview.leadq.co.in').proxyTo, '127.0.0.1:8002');
  // path suffix on the upstream is preserved
  assert.equal(v('mcp-cratio.leadq.co.in').proxyTo, '127.0.0.1:8791/mcp');
  // a static root rather than a proxy
  assert.equal(v('manashi.leadq.co.in').root, '/var/www/html');
  // named upstream block, not host:port
  assert.equal(v('gbt.leadq.co.in').proxyTo, 'kw_gbt_api');
});

test('certificates attach to every domain they cover, case-insensitively', () => {
  const { record: r } = parse('srv1340120');
  const v = (domain) => r.vhosts.find((x) => x.domain.toLowerCase() === domain);

  // one cert, three domains
  for (const d of ['leadq.co.in', 'www.leadq.co.in', 'hrportal.leadq.co.in']) {
    assert.equal(v(d).certName, 'leadq.co.in');
    assert.equal(v(d).certExpiryDays, 34);
  }
  // nginx says KW-Site-visit, certbot says kw-site-visit
  assert.equal(v('kw-site-visit.leadq.co.in').certExpiryDays, 62);

  // served over 443 but certbot has no cert for it — worth a human look
  assert.equal(v('overview.leadq.co.in').ssl, true);
  assert.equal(v('overview.leadq.co.in').certExpiryDays, undefined);
});

test('a cloudflared hostname is attributed to the tunnel, not to nginx', () => {
  const { record: r } = parse('srv1340120');
  const kwatch = r.vhosts.find((x) => x.domain === 'kwatch.leadq.co.in');
  assert.equal(kwatch.source, 'cloudflared');
  assert.equal(kwatch.proxyTo, '127.0.0.1:8050');
  assert.ok(r.web.servers.includes('cloudflared'));
});

test('sites-enabled entries that are files rather than symlinks', () => {
  const { record: r } = parse('srv1340120');
  const notLinks = r.web.sitesEnabled.filter((s) => !s.isSymlink).map((s) => s.name);
  assert.deepEqual(notLinks.sort(), ['hrportal.bak.20260505-044819', 'manashi']);
  assert.equal(r.web.sitesEnabled.find((s) => s.name === 'n8n').target, '/etc/nginx/sites-available/n8n');
});

test('databases and engine states', () => {
  const { record: r } = parse('srv1340120');
  assert.equal(r.databases.Yamini.engine, 'mongodb');
  assert.equal(r.databases.Yamini.collections[0].name, 'customerChats');
  assert.equal(r.databases.Yamini.collections[0].docs, 27368);
  assert.equal(r.databases.kw_manashi.engine, 'postgres');
  assert.ok(!('template0' in r.databases), 'postgres templates are noise');

  // `is-active || echo absent` prints two lines; only the pair means absent
  assert.equal(r.databaseEngines.mongod, 'active');
  assert.equal(r.databaseEngines.postgresql, 'active');
  assert.equal(r.databaseEngines.mysql, 'absent');
});

test('n8n workflows come out of the dump, active flag derived by set difference', () => {
  const { record: r, workflows } = parse('srv1340120');
  assert.equal(Object.keys(workflows).length, 135);
  assert.equal(r.n8n.container, 'n8n-n8n-1');
  assert.equal(r.n8n.activeCount, 12);
  assert.equal(Object.values(workflows).filter((w) => w.active).length, 12);

  // The naming trap from the brief §14: the workflow NAMED Yamini is inactive.
  assert.equal(workflows.zNyAPupAI9GE1UYX.name, 'KW Group – YAMINI WhatsApp AI Support');
  assert.equal(workflows.zNyAPupAI9GE1UYX.active, false);
  // The agents that actually run:
  assert.equal(workflows.bd8s6I7ahQnw7kbs.active, true);
  assert.equal(workflows.Sxy3kN781MAZw71n.active, true);
  // The writeback that would close the Cratio loop exists, and is off.
  assert.equal(workflows.ppXd4bTAUtLaBwB7.name, 'KW 3 · Qualification & CRM Writeback');
  assert.equal(workflows.ppXd4bTAUtLaBwB7.active, false);
});

test('cron: redacted, deduped across root_crontab and user_crontabs, flagged', () => {
  const { record: r } = parse('srv1340120');

  assert.ok(r.cron.every((c) => typeof c.cmd === 'string'), 'every cron row renders a command');
  const mongodump = r.cron.filter((c) => c.cmd.includes('mongodump'));
  assert.equal(mongodump.length, 1, 'the same line appears in both subsections');
  assert.equal(mongodump[0].user, 'root');
  assert.equal(mongodump[0].schedule, '0 2 * * 0');
  assert.equal(mongodump[0].hasSecret, true);
  // kw-collect.sh already redacted this one, so our own pass found nothing to
  // do. The line still describes a credential, so it is still flagged — and
  // the collector's marker is kept verbatim because it names the secret's kind.
  assert.deepEqual(mongodump[0].secretKinds, ['collector-redacted']);
  assert.ok(isRedacted(mongodump[0].cmd));
  assert.ok(!/kwadmin:[^*[]/.test(mongodump[0].cmd), 'no live password survives');

  const bearer = r.cron.find((c) => c.cmd.includes('extract-transcripts'));
  assert.equal(bearer.user, 'claude-deploy');
  assert.equal(bearer.hasSecret, true);

  // /etc/cron.d lines carry a user column between schedule and command
  const certbot = r.cron.find((c) => c.cmd.includes('certbot -q renew'));
  assert.equal(certbot.user, 'root');
  assert.equal(certbot.schedule, '0 */12 * * *');
  assert.equal(certbot.hasSecret, false);

  // systemd timers are folded in alongside cron
  assert.ok(r.cron.some((c) => c.source === 'systemd-timer' && c.unit === 'certbot.timer'));
});

test('logs, storage and packages', () => {
  const { record: r } = parse('srv1340120');
  assert.equal(r.logs.journalSize, '215.6M');
  assert.equal(r.logs.varLogTotal, '3.8G');
  assert.equal(r.logs.largest[0].path, '/var/log/mongodb/mongod.log', '3.5G, found by the size sweep');

  assert.equal(r.storage.bigFiles[0].path, '/root/n8n-db-2026-08-17.sqlite');
  assert.equal(r.packages.upgradable, 66);
});

test('deployment directories, git remotes and .env presence', () => {
  const { record: r } = parse('srv1340120');
  const p = (path) => r.projects.find((x) => x.path === path);

  assert.equal(p('/var/www/kwsite').size, '1.5G');
  assert.equal(p('/opt/kw-manashi').git, true);
  assert.equal(p('/opt/kw-manashi').hasEnv, true);
  assert.equal(p('/opt/kw-manashi').remote, 'git@github-kw:mdo39-ash/kw_manashi.git');

  // a remote with an embedded token must arrive redacted, by us or by the collector
  const kwatch = p('/var/www/kwatch');
  assert.ok(isRedacted(kwatch.remote), `remote not redacted: ${kwatch.remote}`);
  assert.ok(!/ManishKumar9494:(?!\*{3})./.test(kwatch.remote), 'no live token survives');
});

/* ---------------------------------------------------- the quieter servers */

test('srv1870078: the idle second n8n, with its port published to the world', () => {
  const { record: r, workflows } = parse('srv1870078');
  assert.equal(r.state.diskUsedPct, 8);
  assert.equal(r.services.filter((s) => s.state === 'failed').length, 0);
  assert.equal(Object.keys(workflows).length, 3);
  assert.equal(Object.values(workflows).filter((w) => w.active).length, 1);

  const n8nContainer = r.containers.find((c) => c.name === 'n8n-vfa2-n8n-1');
  assert.match(n8nContainer.ports, /0\.0\.0\.0:32769->5678/);
});

test('srv1900820: websites box, no databases, certs read', () => {
  const { record: r } = parse('srv1900820');
  assert.equal(r.state.firewall, 'active');
  assert.equal(r.databases, undefined, 'no databases section content means the key stays absent');
  assert.equal(r.databaseEngines.mongod, 'absent');

  const kwgroup = r.vhosts.find((v) => v.domain === 'kwgroup.in');
  assert.equal(kwgroup.proxyTo, '127.0.0.1:8080');
  assert.equal(kwgroup.certExpiryDays, 78);
});

/* ------------------------------------------------------------ robustness */

test('survives truncation: a dump cut mid-section still yields what it read', () => {
  const full = readText(abs(FIXTURES.srv1340120));
  const truncated = full.slice(0, full.indexOf('===SECTION:DOCKER==='));
  const result = parseVpsDump(truncated);

  assert.equal(result.server, 'srv1340120');
  assert.equal(result.record.state.diskUsedPct, 19);
  assert.equal(result.record.containers, undefined, 'absent section leaves the field untouched');
  assert.ok(result.warnings.some((w) => /section DOCKER absent/.test(w)));
  assert.ok(result.warnings.some((w) => /section PACKAGES absent/.test(w)));

  assert.deepEqual(registry.validate('servers.schema.json', { srv1340120: result.record }), []);
});

test('survives paste artefacts, ANSI colour and interleaved shell prompts', () => {
  const dirty = [
    '===MANIFEST===',
    'schema=2.0',
    'collected_at=2026-08-24T12:03:33Z',
    '[201~===SECTION:HOST===',
    '',
    '---hostnamectl---',
    ' Static hostname: srv1340120',
    '[0;32mOperating System: Ubuntu 24.04.4 LTS[0m',
    'root@srv1340120:~# cat /tmp/whatever',
    '          Kernel: Linux 6.8.0-110-generic',
    '===END===',
  ].join('\n');

  const result = parseVpsDump(dirty);
  assert.equal(result.server, 'srv1340120');
  assert.equal(result.record.state.os, 'Ubuntu 24.04.4 LTS');
  assert.equal(result.record.state.kernel, '6.8.0-110-generic');
});

test('never throws on junk, and says so instead', () => {
  for (const junk of ['', '\n\n\n', 'not a dump at all', '===SECTION:HOST===\n---hostnamectl---\n ']) {
    const result = parseVpsDump(junk);
    assert.equal(result.ok, false);
    assert.ok(result.warnings.length > 0);
  }
});

test('identifies the server from hostnamectl even when the filename disagrees', () => {
  const text = readText(abs(FIXTURES.srv1900820));
  const result = parseVpsDump(text, { sourceFile: 'raw/totally-wrong-name.txt' });
  assert.equal(result.server, 'srv1900820');
  assert.equal(result.record.sourceFile, 'raw/totally-wrong-name.txt');
});
