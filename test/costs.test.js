import test from 'node:test';
import assert from 'node:assert/strict';

import { planFor, registrableDomain, daysUntil } from '../src/costs.js';

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
