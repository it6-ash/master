import test from 'node:test';
import assert from 'node:assert/strict';

import { targetsFrom, testLead, checkIssues } from '../src/check.js';

test('targets come from the servers, not from a maintained list', () => {
  const servers = {
    srv1: {
      vhosts: [
        { domain: 'kwgroup.in', source: 'nginx' },
        { domain: 'www.kwgroup.in', source: 'nginx' },
        { domain: 'n8n.srv1340120.hstgr.cloud', source: 'nginx' },
        { domain: '_', source: 'nginx' },
        { domain: 'kwatch.leadq.co.in', source: 'cloudflared' },
      ],
    },
    srv2: { vhosts: [{ domain: 'kwgroup.in' }] },
  };

  const hosts = targetsFrom(servers).map((t) => t.host);
  assert.deepEqual(hosts, ['kwatch.leadq.co.in', 'kwgroup.in', 'www.kwgroup.in']);

  // www. is its own hostname and can break on its own, so it is NOT collapsed.
  // *.hstgr.cloud is provider-issued and nobody visits it. `_` is a catch-all.
  assert.equal(targetsFrom(servers).find((t) => t.host === 'kwgroup.in').server, 'srv1',
    'first server to claim a hostname owns it');
  assert.deepEqual(targetsFrom(servers, { skip: ['kwgroup.in'] }).map((t) => t.host),
    ['kwatch.leadq.co.in', 'www.kwgroup.in']);
});

test('a test lead is obviously a test lead', () => {
  const form = {
    fields: {
      full_name: 'name', email: 'email', mobile: 'phone', msg: 'message',
      source: 'kw-estate-uptime-check',
    },
  };
  const lead = testLead(form, { today: '2026-08-26' });

  assert.equal(lead.full_name, 'KW Estate monitor');
  assert.equal(lead.mobile, '+91 00000 00000', 'a number nobody can dial');
  assert.match(lead.email, /\+2026-08-26@/, 'plus-addressed with the date, so it filters in one rule');
  assert.match(lead.msg, /Not a real enquiry/);
  // Anything that is not a placeholder name is sent through literally.
  assert.equal(lead.source, 'kw-estate-uptime-check');
  // Only the configured fields are sent — no surprise keys into someone's CRM.
  assert.deepEqual(Object.keys(lead).sort(), ['email', 'full_name', 'mobile', 'msg', 'source']);
});

test('a broken form outranks a down site, and a skipped one raises nothing', () => {
  const report = {
    today: '2026-08-26',
    at: '2026-08-26T05:00:00Z',
    sites: [
      { host: 'a.example.com', url: 'https://a.example.com/', ok: false, error: 'ENOTFOUND', server: 'srv1' },
      { host: 'b.example.com', url: 'https://b.example.com/', ok: true, status: 200, ms: 120, server: 'srv1' },
      { host: 'c.example.com', url: 'https://c.example.com/', ok: true, status: 200, ms: 8065, server: 'srv2' },
    ],
    forms: [
      { id: 'kwgroup-lead', url: 'https://kwgroup.in/x', ok: false, status: 500 },
      { id: 'other', url: 'https://x/y', ok: false, skipped: true, reason: '--no-forms' },
    ],
  };

  const issues = checkIssues(report);
  const byRule = Object.fromEntries(issues.map((i) => [i.rule, i]));

  assert.equal(issues.length, 3, 'down site, slow site, broken form — the skipped form raises nothing');
  assert.equal(byRule['form-broken'].severity, 'critical', 'a lost enquiry costs more than a down internal page');
  assert.equal(byRule['site-unreachable'].severity, 'high');
  assert.equal(byRule['site-slow'].severity, 'medium');
  assert.match(byRule['site-slow'].title, /8\.1s/);
  assert.equal(byRule['site-unreachable'].server, 'srv1');
  for (const i of issues) assert.match(i.id, /^[a-z0-9][a-z0-9-]*$/, `${i.id} must satisfy the issues schema`);
});
