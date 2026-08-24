import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseYaml } from '../src/lib/yaml-lite.js';
import { parseFrontmatter } from '../src/parse/frontmatter.js';
import { abs, readText } from '../src/lib/fsx.js';

test('parses the real Yamini frontmatter', () => {
  const { data, errors, hasFrontmatter } = parseFrontmatter(readText(abs('content/projects/yamini.md')));
  assert.ok(hasFrontmatter);
  assert.deepEqual(errors, []);

  assert.equal(data.id, 'yamini');
  assert.equal(data.server, 'srv1340120');
  assert.equal(data.status, 'partial', 'the trailing "# live | partial | …" comment must be stripped');
  assert.equal(data.url, 'WhatsApp AI · n8n + MongoDB');

  assert.deepEqual(data.tags, ['n8n', 'MongoDB', 'GPT-5 mini', 'WhatsApp Cloud API']);
  assert.equal(data.workflows.length, 3);
  assert.deepEqual(data.services, ['n8n-n8n-1', 'mongod']);

  assert.equal(data.stats.length, 4);
  assert.deepEqual(data.stats[0], { value: '26,437', label: 'Records' });
  assert.equal(data.stats[3].state, 'broken');
});

test('quoted values keep characters that would otherwise be syntax', () => {
  const { value, errors } = parseYaml('a: "has # not a comment"\nb: \'it\'\'s fine\'\nc: plain # gone');
  assert.deepEqual(errors, []);
  assert.equal(value.a, 'has # not a comment');
  assert.equal(value.b, "it's fine");
  assert.equal(value.c, 'plain');
});

test('scalar typing: ints, floats, booleans, null, and strings that merely look numeric', () => {
  const { value } = parseYaml([
    'port: 8002',
    'ratio: 0.59',
    'active: false',
    'resolved: null',
    'version: 6.8.0-110',
    'count: "26,437"',
    'opened: 2026-08-21',
  ].join('\n'));

  assert.equal(value.port, 8002);
  assert.equal(value.ratio, 0.59);
  assert.equal(value.active, false);
  assert.equal(value.resolved, null);
  assert.equal(value.version, '6.8.0-110', 'dotted versions stay strings');
  assert.equal(value.count, '26,437');
  assert.equal(value.opened, '2026-08-21', 'dates stay strings so the schema can format-check them');
});

test('nested block maps and sequences', () => {
  const { value, errors } = parseYaml([
    'top:',
    '  inner:',
    '    deep: true',
    '  list:',
    '    - one',
    '    - two',
    'flush:',
    '- a',
    '- b',
  ].join('\n'));

  assert.deepEqual(errors, []);
  assert.equal(value.top.inner.deep, true);
  assert.deepEqual(value.top.list, ['one', 'two']);
  assert.deepEqual(value.flush, ['a', 'b'], 'a sequence at its key\'s own indent is legal YAML');
});

test('sequence of block maps', () => {
  const { value, errors } = parseYaml([
    'stats:',
    '  - value: 1',
    '    label: One',
    '  - value: 2',
    '    label: Two',
  ].join('\n'));

  assert.deepEqual(errors, []);
  assert.deepEqual(value.stats, [{ value: 1, label: 'One' }, { value: 2, label: 'Two' }]);
});

test('reports rather than guesses: duplicate keys, tabs, unterminated collections', () => {
  assert.match(parseYaml('a: 1\na: 2').errors[0].message, /duplicate key "a"/);
  assert.match(parseYaml('a:\n\tb: 1').errors[0].message, /tab character/);
  assert.match(parseYaml('a: [1, 2').errors[0].message, /unterminated flow sequence/);
  assert.match(parseYaml('a: |\n  block').errors[0].message, /block scalars/);
});

test('frontmatter guards', () => {
  assert.match(parseFrontmatter('no fences here').errors[0].message, /missing frontmatter/);
  assert.match(parseFrontmatter('---\na: 1\nstill open').errors[0].message, /unterminated frontmatter/);

  const ok = parseFrontmatter('---\na: 1\n---\nbody line\n');
  assert.equal(ok.body.trim(), 'body line');
  assert.equal(ok.bodyStartLine, 4);
});
