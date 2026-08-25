import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseVpsDump } from '../src/ingest/vps-dump.js';
import { parseN8nList, groupFor, isNoise } from '../src/ingest/n8n-list.js';
import { parseMongoStats } from '../src/ingest/mongo-stats.js';
import { detectFormat } from '../src/ingest/index.js';
import { deriveProjects, mergeProjects, slugFor } from '../src/derive-projects.js';
import { testClaim, reconcileIssues } from '../src/claims.js';
import { diffSnapshots, autoIssues } from '../src/diff.js';
import { abs, readText } from '../src/lib/fsx.js';

const FIXTURE = 'test/fixtures/kw-collect-srv1340120-2026-08-24T1203.txt';
const dump = parseVpsDump(readText(abs(FIXTURE)), { sourceFile: FIXTURE });
const servers = { [dump.server]: dump.record };

/* ------------------------------------------------------ format detection */

test('detects each format from content, never from the filename', () => {
  assert.equal(detectFormat(readText(abs(FIXTURE))).format, 'vps-dump');
  assert.equal(detectFormat('zNyAPupAI9GE1UYX|KW Group YAMINI\nbd8s6I7ahQnw7kbs|D6 Reply').format, 'n8n-list');
  assert.equal(detectFormat('customerChats | 26437 docs\nauthLogs | 130 docs').format, 'mongo-stats');
  assert.equal(detectFormat('Yamini\tcustomerChats\t27368').format, 'mongo-stats');
  assert.equal(detectFormat('the quick brown fox').format, 'unknown');
});

test('a dump missing its section headers is still recognised by hostnamectl', () => {
  const result = detectFormat(' Static hostname: srv1340120\n  Icon name: computer-vm');
  assert.equal(result.format, 'vps-dump');
  assert.equal(result.confidence, 'medium');
});

/* ----------------------------------------------------------- n8n list */

test('grouping rules from the brief, applied to real workflow names', () => {
  assert.equal(groupFor('KW Group – YAMINI WhatsApp AI Support'), 'Yamini');
  assert.equal(groupFor('D6 WhatsApp Weekly Broadcast'), 'Yamini');
  assert.equal(groupFor('KW: Cratio -> Meta CAPI (daily, by Updated Time)'), 'Attribution');
  assert.equal(groupFor('4 · KW Google Enhanced Conversions · DAILY (with GCLID)'), 'Attribution');
  assert.equal(groupFor('KW CV Screening Pipeline v7'), 'HR');
  assert.equal(groupFor('hr screening system community1'), 'HR');
  assert.equal(groupFor('Call Recording Analyser'), 'Sales QA');
  assert.equal(groupFor('GB Delhi 6'), 'KW GBT');
  assert.equal(groupFor('web-chat-kwbp'), 'Web chat');
  assert.equal(groupFor('Media prompt'), 'Ungrouped');
});

test('template imports are marked as noise', () => {
  assert.equal(isNoise('67-Automatic_Shopify_Order_Fulfillment_Process'), true);
  assert.equal(isNoise('My workflow 2'), true);
  assert.equal(isNoise('empty3'), true);
  assert.equal(isNoise('WhatsApp Chat Agent'), false);
  assert.equal(isNoise('GB Delhi 6'), false);
});

test('active is a set difference, not a guess', () => {
  const all = 'aaaaaaaa1111|One\nbbbbbbbb2222|Two\ncccccccc3333|Three';
  const active = 'bbbbbbbb2222|Two';
  const { workflows } = parseN8nList(all, { activeText: active });

  assert.equal(Object.keys(workflows).length, 3);
  assert.equal(workflows.bbbbbbbb2222.active, true);
  assert.equal(workflows.aaaaaaaa1111.active, false);
});

test('with no active list supplied, nothing is claimed active and it says so', () => {
  const { workflows, warnings } = parseN8nList('aaaaaaaa1111|One');
  assert.equal(workflows.aaaaaaaa1111.active, false);
  assert.match(warnings[0], /no --active=true list/);
});

/* -------------------------------------------------------- mongo stats */

test('collection counts, in every shape this estate produces', () => {
  const piped = parseMongoStats('customerChats | 26437 docs\nallowedUsers | 5 docs');
  assert.equal(piped.databases.Yamini.collections[0].name, 'customerChats');
  assert.equal(piped.databases.Yamini.collections[0].docs, 26437);

  const tabbed = parseMongoStats('Yamini\tcustomerChats\t27368\nYamini\tauthLogs\t130');
  assert.equal(tabbed.databases.Yamini.collections[0].docs, 27368);
  assert.equal(tabbed.databases.Yamini.collections.length, 2);

  const colon = parseMongoStats('customerChats: 26437', { db: 'Other' });
  assert.equal(colon.databases.Other.collections[0].docs, 26437);
});

test('a mongo error is a warning, not a crash or a zero', () => {
  const { databases, warnings } = parseMongoStats('mongo_error\tconnection refused');
  assert.deepEqual(databases, {});
  assert.match(warnings[0], /connection refused/);
});

/* ---------------------------------------------------- project derivation */

test('projects are discovered from real server data', () => {
  const derived = deriveProjects(servers);
  const ids = Object.keys(derived);

  assert.ok(ids.length > 10, 'srv1340120 runs more than ten things');

  // a hostname whose upstream resolves to a running unit
  const overview = derived['overview-leadq'];
  assert.equal(overview.server, 'srv1340120');
  assert.equal(overview.status, 'live');
  assert.equal(overview.discovered.port, 8002);
  assert.equal(overview.discovered.backend, 'dashboard2');

  // a hostname served by a container
  const skills = derived['skills-leadq'];
  assert.equal(skills.discovered.backend, 'kwskills-app');
  assert.equal(skills.status, 'live');

  // a failed unit surfaces as a broken project
  const leadApi = derived['lead-api'];
  assert.equal(leadApi.status, 'broken', 'lead-api.service is failed');
});

test('a bare catch-all server_name is not a project', () => {
  const derived = deriveProjects(servers);
  assert.ok(!derived['srv1340120'], 'the host FQDN has no upstream and no docroot');
});

test('the same project seen from two angles is not two projects', () => {
  const derived = deriveProjects(servers);
  // kwatch.leadq.co.in (vhost) and /var/www/kwatch (directory) are one thing.
  const kwatchLike = Object.values(derived).filter((p) => (p.services ?? []).includes('kwatch'));
  assert.equal(kwatchLike.length, 1);
});

test('www and the apex collapse into one project', () => {
  const derived = deriveProjects(servers);
  assert.ok(!derived['www-leadq'], 'www. is stripped by the slug');
  assert.equal(slugFor('www.leadq.co.in'), 'leadq');
  assert.equal(slugFor('n8n.srv1340120.hstgr.cloud'), 'n8n-srv1340120');
});

test('a doc enriches a derived project without losing the evidence', () => {
  const derived = deriveProjects(servers);
  const merged = mergeProjects([{
    id: 'overview-leadq',
    name: 'LeadQ Overview V2',
    status: 'live',
    summary: 'Analytical dashboard.',
    services: ['dashboard2'],
    sourceFile: 'content/projects/overview-leadq.md',
  }], derived);

  const project = merged.find((p) => p.id === 'overview-leadq');
  assert.equal(project.origin, 'documented');
  assert.equal(project.name, 'LeadQ Overview V2', 'the doc wins the name');
  assert.equal(project.summary, 'Analytical dashboard.');
  assert.equal(project.discovered.port, 8002, 'derived evidence survives the merge');
});

/* ---------------------------------------------------------- claims */

test('a claim that live data contradicts is reconciled, not repeated', () => {
  // The 18 Aug handover said mongod was on 0.0.0.0. The 24 Aug dump says otherwise.
  const result = testClaim(
    { kind: 'port-exposed', server: 'srv1340120', port: 27017, expect: true }, servers,
  );
  assert.equal(result.status, 'reconciled');
  assert.match(result.detail, /bound to 127\.0\.0\.1/);
});

test('a claim live data still supports holds', () => {
  const result = testClaim(
    { kind: 'port-exposed', server: 'srv1340120', port: 8899, expect: true }, servers,
  );
  assert.equal(result.status, 'holds', 'the media server really is still public');
});

test('firewall, unit and value claims', () => {
  assert.equal(testClaim({ kind: 'firewall', server: 'srv1340120', expect: 'inactive' }, servers).status, 'reconciled');
  assert.equal(testClaim({ kind: 'firewall', server: 'srv1340120', expect: 'active' }, servers).status, 'holds');
  assert.equal(testClaim({ kind: 'unit-state', server: 'srv1340120', unit: 'lead-api', expect: 'failed' }, servers).status, 'holds');
  assert.equal(testClaim({ kind: 'value', server: 'srv1340120', path: 'n8n.dbSizeBytes', op: 'gt', expect: 1e9 }, servers).status, 'holds');
});

test('missing data is unverifiable, never silently "fixed"', () => {
  assert.equal(testClaim({ kind: 'firewall', server: 'nope' }, servers).status, 'unverifiable');
  assert.equal(testClaim({ kind: 'value', server: 'srv1340120', path: 'no.such.path' }, servers).status, 'unverifiable');
  assert.equal(testClaim(null, servers).status, 'unverifiable');
});

test('issues without a claim pass through untouched', () => {
  const [plain] = reconcileIssues([{ id: 'x', severity: 'high', title: 'T', source: 'manual', opened: '2026-08-18' }], servers);
  assert.equal(plain.claimStatus, undefined);
});

/* ------------------------------------------------------- auto issues */

test('auto issues fire on the real record, with stable ids', () => {
  const issues = autoIssues(servers, { today: '2026-08-24' });
  const rules = issues.map((i) => i.rule);

  assert.ok(rules.includes('unit-failed'), 'fastapi_app and lead-api are failed');
  assert.ok(rules.includes('cron-secret'), 'the mongodump line carries a credential');
  assert.ok(rules.includes('sites-enabled-not-symlink'), 'manashi is a plain file');
  assert.ok(rules.includes('container-stuck-created'), 'n8n-traefik-1, 115 days');
  assert.ok(rules.includes('kernel-stale'));

  // ufw is active and mongo is loopback-only, so these must NOT fire
  assert.ok(!rules.includes('ufw-inactive'));
  assert.ok(!rules.includes('db-port-exposed'), 'mongod is on 127.0.0.1');
  assert.ok(!rules.includes('disk-high'), 'disk is 19%');

  for (const issue of issues) {
    assert.match(issue.id, /^[a-z0-9][a-z0-9-]*$/, `bad id: ${issue.id}`);
    assert.equal(issue.source, 'auto');
  }
});

test('re-running auto issues keeps the original opened date', () => {
  const first = autoIssues(servers, { today: '2026-08-18' });
  const second = autoIssues(servers, { today: '2026-09-01', previous: first });
  const target = second.find((i) => i.rule === 'unit-failed');
  assert.equal(target.opened, '2026-08-18', 'an issue that never closed keeps its opening date');
});

/* -------------------------------------------------------------- diff */

test('diff emits nothing when a snapshot is compared with itself', () => {
  const events = diffSnapshots(dump.record, dump.record, { server: 'srv1340120', at: '2026-08-24' });
  assert.deepEqual(events, [], 'an unchanged server produces no noise');
});

test('diff catches the changes that matter', () => {
  const before = JSON.parse(JSON.stringify(dump.record));
  const after = JSON.parse(JSON.stringify(dump.record));

  // a unit falls over
  after.services.find((s) => s.name === 'mongod').state = 'failed';
  // mongo gets re-exposed
  after.ports.find((p) => p.port === 27017).exposed = true;
  // disk climbs past the threshold
  after.state.diskUsedPct = 84;
  // a collection grows
  after.databases.Yamini.collections[0].docs += 1200;

  const events = diffSnapshots(before, after, { server: 'srv1340120', at: '2026-08-30' });
  const types = events.map((e) => e.type);

  assert.ok(types.includes('service.failed'));
  assert.ok(types.includes('port.exposed'));
  assert.ok(types.includes('disk.jump'));
  assert.ok(types.includes('disk.threshold'));
  assert.ok(types.includes('db.growth'));

  const exposure = events.find((e) => e.type === 'port.exposed');
  assert.equal(exposure.severity, 'critical', 'a database port is not a normal port');
  assert.equal(exposure.port, 27017);
});

test('a section absent from the newer snapshot produces no phantom deletions', () => {
  const after = { ...dump.record };
  delete after.services;
  const events = diffSnapshots(dump.record, after, { server: 'srv1340120', at: '2026-08-30' });
  assert.ok(!events.some((e) => e.type === 'service.disappeared'),
    'a truncated dump must not read as 87 units vanishing');
});
