import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseInterval, loadHosts } from '../src/sync.js';

test('interval parsing accepts the units a human would type', () => {
  assert.equal(parseInterval('30m'), 1800000);
  assert.equal(parseInterval('6h'), 21600000);
  assert.equal(parseInterval('1d'), 86400000);
  assert.equal(parseInterval('90'), 5400000, 'a bare number means minutes');
});

test('a sub-minute poll of a production box is refused', () => {
  assert.equal(parseInterval('5s'), null);
  assert.equal(parseInterval('30s'), null);
  assert.equal(parseInterval('0'), null);
});

test('nonsense intervals are refused rather than guessed at', () => {
  for (const bad of ['', 'soon', 'every hour', '6 hours please', null, undefined]) {
    assert.equal(parseInterval(bad), null, `should refuse: ${bad}`);
  }
});

test('hosts fall back to the IPs already ingested, so a first run needs no config', () => {
  const hosts = loadHosts();
  assert.ok(hosts.length >= 3, 'all three servers should be reachable targets');

  const main = hosts.find((h) => h.id === 'srv1340120');
  assert.equal(main.host, '72.62.228.194');
  assert.equal(main.user, 'root');

  for (const h of hosts) {
    assert.ok(h.host, `${h.id} has no address`);
    assert.ok(!('password' in h), 'a password must never appear in a host record');
  }
});
