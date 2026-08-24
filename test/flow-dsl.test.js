import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFlow, extractFlowBlocks } from '../src/parse/flow-dsl.js';
import { parseFrontmatter } from '../src/parse/frontmatter.js';
import { abs, readText } from '../src/lib/fsx.js';

/** The real Yamini flow block, not a hand-made fixture. */
function yaminiFlow() {
  const { body, bodyStartLine } = parseFrontmatter(readText(abs('content/projects/yamini.md')));
  const blocks = extractFlowBlocks(body, { startLine: bodyStartLine });
  const flow = blocks.find((b) => b.lang === 'flow');
  assert.ok(flow, 'yamini.md should contain a ```flow block');
  return parseFlow(flow.code, { startLine: flow.startLine });
}

test('parses the Yamini flow with no errors', () => {
  const { nodes, edges, errors } = yaminiFlow();
  assert.deepEqual(errors, []);
  assert.equal(nodes.length, 8);
  assert.equal(edges.length, 8);
});

test('carries kind, label, sublabel and state', () => {
  const { nodes } = yaminiFlow();
  const db = nodes.find((n) => n.id === 'db');
  assert.equal(db.kind, 'store');
  assert.equal(db.label, 'MongoDB');
  assert.equal(db.sublabel, 'Yamini.customerChats');
  assert.equal(db.state, null, 'db declares no state, so it stays neutral');

  const crm = nodes.find((n) => n.id === 'crm');
  assert.equal(crm.kind, 'ext');

  const lead = nodes.find((n) => n.id === 'lead');
  assert.equal(lead.state, null);
  assert.equal(lead.sublabel, 'click-to-WA ads');
});

test('carries edge state and optional label', () => {
  const { edges } = yaminiFlow();
  const broken = edges.find((e) => e.from === 'qual' && e.to === 'crm');
  assert.equal(broken.state, 'broken');
  assert.equal(broken.label, 'never fires');

  const plain = edges.find((e) => e.from === 'lead' && e.to === 'meta');
  assert.equal(plain.state, 'live');
  assert.equal(plain.label, null);
});

test('reports an edge that references an undeclared node', () => {
  const { errors } = parseFlow(`
    node a "A"
    edge a -> ghost live
  `);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /undeclared node "ghost"/);
});

test('reports duplicate node ids and keeps the first', () => {
  const { nodes, errors } = parseFlow(`
node a "First"
node a "Second"
  `);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, 'First');
  assert.match(errors[0].message, /duplicate node id "a"/);
});

test('optional @x,y overrides auto-layout', () => {
  const { nodes, errors } = parseFlow('node a "A" "sub" live @120,-40');
  assert.deepEqual(errors, []);
  assert.equal(nodes[0].x, 120);
  assert.equal(nodes[0].y, -40);
});

test('a malformed line is skipped, the rest of the block still parses', () => {
  const { nodes, edges, errors } = parseFlow(`
node a "A"
wobble b "B"
node c "C"
edge a -> c data
  `);
  assert.deepEqual(nodes.map((n) => n.id), ['a', 'c']);
  assert.equal(edges.length, 1);
  assert.match(errors[0].message, /unknown statement "wobble"/);
});

test('does not throw on an unterminated quote', () => {
  const { errors } = parseFlow('node a "A');
  assert.match(errors[0].message, /unterminated quoted string/);
});

test('# starts a comment, and blank lines are ignored', () => {
  const { nodes, errors } = parseFlow(`
# a comment
node a "A"   # trailing comment

  `);
  assert.deepEqual(errors, []);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, 'A');
});

test('extractFlowBlocks reports true line numbers and both languages', () => {
  const md = ['intro', '', '```flow', 'node a "A"', '```', '', '```mermaid', 'graph TD;', '```'].join('\n');
  const blocks = extractFlowBlocks(md);
  assert.deepEqual(blocks.map((b) => b.lang), ['flow', 'mermaid']);
  assert.equal(blocks[0].startLine, 4, 'the first code line of the flow block is line 4');
});
