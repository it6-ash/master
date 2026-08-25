import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { abs, exists, readText } from '../src/lib/fsx.js';

const run = (slug) => execFileSync(process.execPath, [abs('src/new-project.js'), slug], { encoding: 'utf8' });

test('scaffolds a project pre-filled from the last ingest', () => {
  const file = abs('content/projects/tmp-scaffold-check.md');
  try {
    // kwatch-leadq is a discovered project, so its facts should come through.
    const out = run('kwatch-leadq');
    assert.match(out, /kwatch-leadq\.md/);

    const text = readText(abs('content/projects/kwatch-leadq.md'));
    assert.match(text, /^id: kwatch-leadq$/m);
    assert.match(text, /^server: srv1340120$/m);
    assert.match(text, /services: \[kwatch\]/);
    assert.match(text, /port 8050/, 'discovered facts are carried in');
    assert.match(text, /```flow/, 'starts with a flow block to fill in');
  } finally {
    fs.rmSync(abs('content/projects/kwatch-leadq.md'), { force: true });
    fs.rmSync(file, { force: true });
  }
});

test('refuses a bad slug and refuses to clobber', () => {
  assert.throws(() => run('Not A Slug'), /Command failed/);
  assert.throws(() => run('yamini'), /Command failed/, 'yamini.md already exists');
});
