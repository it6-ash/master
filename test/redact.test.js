import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactString, scanString, redactDeep, scanDeep, PLACEHOLDER_RE } from '../src/lib/redact.js';
import { abs, readJson } from '../src/lib/fsx.js';

/** The invariant the whole redaction design rests on. */
function agree(s) {
  const scanned = scanString(s).length > 0;
  const redacted = redactString(s).text !== s;
  assert.equal(scanned, redacted, `scan and redact disagree about: ${JSON.stringify(s)}`);
}

test('connection-string credentials are redacted, host and user survive', () => {
  const line = '0 2 * * 0 mongodump --uri="mongodb://backup:s3cr3tPass@127.0.0.1:27017/Yamini" --archive=/backups/y.gz';
  const { text, kinds } = redactString(line);

  assert.ok(kinds.includes('uri-credentials'));
  assert.ok(!text.includes('s3cr3tPass'), 'the password must not survive');
  assert.ok(text.includes('mongodb://backup:'), 'scheme and username stay readable');
  assert.ok(text.includes('127.0.0.1:27017/Yamini'), 'host and database stay readable');
  assert.ok(text.includes('--archive=/backups/y.gz'), 'the rest of the command is untouched');
  agree(line);
});

test('common token shapes', () => {
  for (const [sample, kind] of [
    ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['ghp_' + 'a'.repeat(36), 'github-token'],
    ['xoxb-123456789012-abcdefghijkl', 'slack-token'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g', 'jwt'],
    ['N8N_ENCRYPTION_KEY=9f2c1e7b44aa10de', 'assigned-secret'],
    ['JWT_SECRET=abcdef123456', 'assigned-secret'],
    ['DB_PASSWORD=hunter2hunter2', 'assigned-secret'],
    ['  "password": "correct-horse"', 'assigned-secret'],
    ['curl -H "Authorization: Bearer abcdef1234567890"', 'auth-header'],
    ['mysqldump -u root -phunter2 mydb', 'mysql-inline-password'],
    ['psql --password s3cret', 'flag-secret'],
  ]) {
    const { text, kinds } = redactString(sample);
    assert.ok(kinds.includes(kind), `${kind} did not fire on ${JSON.stringify(sample)}`);
    assert.match(text, PLACEHOLDER_RE);
    agree(sample);
  }
});

test('a private key block is removed whole', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----';
  const { text } = redactString(pem);
  assert.equal(text, '[REDACTED:private-key-block]');
});

test('does not fire on the things a VPS dump is full of', () => {
  for (const benign of [
    'mkdir -p /var/backups',
    'docker run -p 8080:80 nginx',
    '127.0.0.1:5678->5678/tcp',
    'n8n.srv1340120.hstgr.cloud -> 127.0.0.1:5678',
    'overview.leadq.co.in',
    'Ubuntu 24.04.4 LTS, kernel 6.8.0-110-generic',
    '0 2 * * 0 /usr/bin/certbot renew --quiet',
    'auth=disabled',
    'password: none',
    'AI Bot fields have been null since Aug 2025',
    'Token bucket rate limiter enabled',
    'authorization service running',
  ]) {
    assert.equal(redactString(benign).text, benign, `false positive on: ${benign}`);
    assert.deepEqual(scanString(benign), [], `false positive on: ${benign}`);
  }
});

test('already-redacted text is stable under re-redaction', () => {
  const once = redactString('DB_PASSWORD=hunter2hunter2').text;
  assert.equal(redactString(once).text, once, 'redaction must be idempotent');
  assert.deepEqual(scanString(once), [], 'a placeholder must not look like a secret');
});

test('deep walks hit values and report a path, and never leak in the preview', () => {
  const record = {
    name: 'srv1340120',
    cron: [{ user: 'root', cmd: 'mongodump --uri=mongodb://u:LEAKED_PW@localhost/db', hasSecret: false }],
    secretKinds: ['none-yet'],
  };

  const hits = scanDeep(record);
  assert.equal(hits.length, 1, 'field NAMES like hasSecret/secretKinds must not trip the scanner');
  assert.equal(hits[0].path, '/cron/0/cmd');
  assert.ok(!hits[0].preview.includes('LEAKED_PW'), 'the finding preview must itself be redacted');

  const { value, kinds } = redactDeep(record);
  assert.ok(kinds.includes('uri-credentials'));
  assert.deepEqual(scanDeep(value), [], 'redactDeep output must survive scanDeep');
});

test('the committed data/ tree is clean', () => {
  for (const name of ['servers.json', 'workflows.json', 'issues.json']) {
    const result = readJson(abs('data', name));
    assert.ok(result.ok, `data/${name} should parse`);
    assert.deepEqual(scanDeep(result.value), [], `data/${name} contains a credential-shaped string`);
  }
});
