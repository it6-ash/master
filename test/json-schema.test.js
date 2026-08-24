import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SchemaRegistry } from '../src/lib/json-schema.js';
import { abs, readJson, listFiles, isJson } from '../src/lib/fsx.js';

function loadRegistry() {
  const registry = new SchemaRegistry();
  for (const file of listFiles(abs('schema'), isJson)) {
    const result = readJson(file);
    assert.ok(result.ok, `${file}: ${result.error ?? ''}`);
    registry.add(result.value);
  }
  return registry;
}

const registry = loadRegistry();
const messages = (errors) => errors.map((e) => `${e.path} ${e.message}`).join(' | ');

test('every schema file parses and declares an $id', () => {
  for (const file of listFiles(abs('schema'), isJson)) {
    const { value } = readJson(file);
    assert.ok(value.$id, `${file} has no $id`);
    assert.ok(registry.get(value.$id));
  }
});

test('a well-formed server record validates', () => {
  const errors = registry.validate('servers.schema.json', {
    srv1340120: {
      name: 'srv1340120',
      role: 'Apps & Automation',
      ip: '72.62.228.194',
      provider: 'Hostinger',
      specs: { cpu: 4, cpuModel: 'AMD EPYC 7543P', ram: '15Gi', disk: '193G' },
      state: { diskUsedPct: 18, uptime: '112 days', rebootPending: true, firewall: 'active' },
      services: [{ name: 'dashboard2', state: 'running', desc: 'LeadQ Dashboard V2', port: 8002 }],
      containers: [{ name: 'n8n-n8n-1', image: 'n8nio/n8n', state: 'running', ports: '127.0.0.1:5678->5678/tcp' }],
      ports: [{ port: 27017, bind: '0.0.0.0', proc: 'mongod', exposed: true }],
      vhosts: [{ domain: 'overview.leadq.co.in', proxyTo: '127.0.0.1:8002', certExpiryDays: 41, source: 'traefik' }],
      cron: [{ user: 'root', schedule: '0 2 * * 0', cmd: 'mongodump …', hasSecret: true }],
      databases: { Yamini: { engine: 'mongodb', collections: [{ name: 'customerChats', docs: 26437 }] } },
      lastIngest: '2026-08-21T06:30:00Z',
      sourceFile: 'raw/2026-08-21-srv1340120.txt',
    },
  });
  assert.deepEqual(errors, [], messages(errors));
});

test('catches the mistakes a broken parser would actually make', () => {
  const cases = [
    [{ srv1: { role: 'x' } }, /missing required property "name"/],
    [{ srv1: { name: 's', ip: '999.1.1.1' } }, /not a valid ipv4/],
    [{ srv1: { name: 's', state: { diskUsedPct: 118 } } }, /> maximum 100/],
    [{ srv1: { name: 's', state: { diskUsedPct: '18%' } } }, /expected integer, got string/],
    [{ srv1: { name: 's', services: [{ name: 'x', state: 'zombie' }] } }, /not one of/],
    [{ srv1: { name: 's', ports: [{ bind: '0.0.0.0' }] } }, /missing required property "port"/],
    [{ srv1: { name: 's', typo: 1 } }, /unknown property "typo"/],
    [{ 'BAD ID': { name: 's' } }, /not a valid property name/],
    [{ srv1: { name: 's', lastIngest: '2026-08-21' } }, /not a valid date-time/],
  ];
  for (const [value, pattern] of cases) {
    const errors = registry.validate('servers.schema.json', value);
    assert.ok(errors.length > 0, `expected a failure for ${JSON.stringify(value)}`);
    assert.match(messages(errors), pattern);
  }
});

test('cross-file $ref: a snapshot embeds a server record', () => {
  const good = {
    server: 'srv1340120',
    takenAt: '2026-08-21T06:30:00Z',
    sourceSha256: 'a'.repeat(64),
    parser: 'vps-dump',
    record: { name: 'srv1340120', state: { firewall: 'active' } },
  };
  assert.deepEqual(registry.validate('snapshot.schema.json', good), []);

  const bad = { ...good, record: { name: 'srv1340120', state: { firewall: 'maybe' } } };
  assert.match(messages(registry.validate('snapshot.schema.json', bad)), /\/record\/state\/firewall.*not one of/);
});

test('issues: auto entries are constrained to known rules', () => {
  const base = { id: 'x', severity: 'high', title: 'T', source: 'auto', opened: '2026-08-21' };
  assert.deepEqual(registry.validate('issues.schema.json', [{ ...base, rule: 'ufw-inactive' }]), []);
  assert.match(messages(registry.validate('issues.schema.json', [{ ...base, rule: 'made-up' }])), /not one of/);
  assert.match(messages(registry.validate('issues.schema.json', [{ ...base, id: 'Not A Slug' }])), /does not match/);
});

test('project frontmatter: status is a closed set, stats are capped', () => {
  const base = { id: 'p', name: 'P', status: 'live' };
  assert.deepEqual(registry.validate('project-frontmatter.schema.json', base), []);
  assert.match(messages(registry.validate('project-frontmatter.schema.json', { ...base, status: 'sorta' })), /not one of/);
  assert.match(
    messages(registry.validate('project-frontmatter.schema.json', {
      ...base,
      stats: Array.from({ length: 7 }, () => ({ value: '1', label: 'x' })),
    })),
    /maximum 6/,
  );
});
