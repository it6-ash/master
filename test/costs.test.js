import test from 'node:test';
import assert from 'node:assert/strict';

import { planFor, registrableDomain, daysUntil, costIssues } from '../src/costs.js';

test('KVM tier comes from the vCPU count, not from a hardcoded list', () => {
  assert.equal(planFor({ virt: 'kvm', cpu: 4 }), 'KVM 4');
  assert.equal(planFor({ virt: 'kvm', cpu: 2 }), 'KVM 2');
  assert.equal(planFor({ virt: 'kvm', cpu: 3 }), null, 'no tier invented for an off-menu size');
  assert.equal(planFor({ virt: 'lxc', cpu: 4 }), null, 'not a KVM, not a KVM plan');
  assert.equal(planFor(undefined), null);
});

test('registrable domain: co.in is two labels of public suffix', () => {
  // Getting this wrong bills "co.in" as a domain and misses leadq.co.in.
  assert.equal(registrableDomain('gbt.leadq.co.in'), 'leadq.co.in');
  assert.equal(registrableDomain('leadq.co.in'), 'leadq.co.in');
  assert.equal(registrableDomain('www.kwbluepearl.com'), 'kwbluepearl.com');
  assert.equal(registrableDomain('KW-Site-visit.leadq.co.in'), 'leadq.co.in');
  assert.equal(registrableDomain('kwgroup.in'), 'kwgroup.in');
});

test('provider hostnames are not renewable and never appear on the bill', () => {
  assert.equal(registrableDomain('n8n.srv1340120.hstgr.cloud'), null);
  assert.equal(registrableDomain('srv1340120.hstgr.cloud'), null);
  assert.equal(registrableDomain('_'), null);
  assert.equal(registrableDomain('72.62.228.194'), null);
  assert.equal(registrableDomain(undefined), null);
});

test('daysUntil counts whole days and goes negative once missed', () => {
  assert.equal(daysUntil('2026-09-01', '2026-08-25'), 7);
  assert.equal(daysUntil('2026-08-25', '2026-08-25'), 0);
  assert.equal(daysUntil('2026-08-20', '2026-08-25'), -5);
  assert.equal(daysUntil(null, '2026-08-25'), null, 'no date is not "today"');
});

test('a cancelled subscription becomes an issue; a renewing one does not', () => {
  const lines = [
    { kind: 'vps', label: 'srv1900820', server: 'srv1900820', autoRenew: false, expiresOn: '2027-08-13', gross: 36801.84 },
    { kind: 'vps', label: 'srv1340120', server: 'srv1340120', autoRenew: true, expiresOn: '2027-03-05', gross: 36801.84 },
    { kind: 'domain', label: 'kwgroup.in', autoRenew: false, expiresOn: null },
  ];

  const issues = costIssues(lines, { today: '2026-08-25' });
  assert.equal(issues.length, 1, 'only the cancelled line with a known date');
  assert.equal(issues[0].server, 'srv1900820');
  assert.equal(issues[0].source, 'auto');
  assert.match(issues[0].id, /^[a-z0-9][a-z0-9-]*$/, 'id must satisfy the issues schema');
  assert.match(issues[0].title, /stops on 2027-08-13/);

  // Far out it is high; inside the last quarter there is no time left to argue.
  assert.equal(issues[0].severity, 'high');
  assert.equal(costIssues(lines, { today: '2027-07-01' })[0].severity, 'critical');
});
