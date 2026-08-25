import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { abs } from '../src/lib/fsx.js';
import { pruneSnapshots } from '../src/ingest/index.js';
import { pruneRaw } from '../src/sync.js';

/**
 * Both pruners rely on the filenames sorting chronologically. They do — the
 * collector stamps 2026-08-24T1203 — but that is the assumption worth pinning:
 * get it wrong and a timer quietly deletes the newest snapshot every six hours.
 */

const SERVER = '__prune_test__';

test('pruneSnapshots keeps the newest N by name', (t) => {
  const dir = abs('data', 'snapshots', SERVER);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(dir, { recursive: true });

  const stamps = ['2026-08-24T1203', '2026-08-24T1803', '2026-08-25T0003', '2026-09-01T1203'];
  for (const s of stamps) fs.writeFileSync(`${dir}/${s}.json`, '{}');

  assert.equal(pruneSnapshots(SERVER, 2), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08-25T0003.json', '2026-09-01T1203.json']);

  assert.equal(pruneSnapshots(SERVER, 2), 0, 'idempotent once at the cap');
  assert.equal(pruneSnapshots(SERVER, 99), 0, 'a cap above the count deletes nothing');
});

test('pruneRaw only touches its own host', (t) => {
  const dir = abs('raw');
  const mine = ['2026-08-24T1203', '2026-08-25T1203', '2026-08-26T1203']
    .map((s) => `${dir}/kw-collect-${SERVER}-${s}.txt`);
  const theirs = `${dir}/kw-collect-srvOTHER-2026-08-24T1203.txt`;

  t.after(() => [...mine, theirs].forEach((f) => fs.rmSync(f, { force: true })));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [...mine, theirs]) fs.writeFileSync(f, 'x');

  assert.equal(pruneRaw(SERVER, 1), 2);
  assert.ok(fs.existsSync(mine[2]), 'newest of mine survives');
  assert.ok(!fs.existsSync(mine[0]));
  assert.ok(fs.existsSync(theirs), 'another host is never collateral');
});
