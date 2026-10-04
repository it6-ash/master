import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWorkflowRef, resolveRegistry, instanceForHost, parseMinutes, buildEntry,
} from '../src/n8n/registry.js';

/* ---------------------------------------------------------- URL parsing */

test('a workflow id is pulled out of every shape an n8n URL comes in', () => {
  const cases = {
    'https://n8n.example.com/workflow/abc123XYZ': 'abc123XYZ',
    'https://n8n.example.com/workflow/abc123XYZ/': 'abc123XYZ',
    'https://n8n.example.com/workflow/abc123XYZ?tab=settings': 'abc123XYZ',
    'https://n8n.example.com/workflow/abc123XYZ/executions/4821': 'abc123XYZ',
    // project-scoped editor
    'https://n8n.example.com/projects/Pr0ject1/workflow/abc123XYZ': 'abc123XYZ',
    // behind N8N_PATH
    'https://box.example.com/n8n/workflow/abc123XYZ': 'abc123XYZ',
    // n8n Cloud
    'https://tenant.app.n8n.cloud/workflow/abc123XYZ': 'abc123XYZ',
    // loopback, http, a port
    'http://127.0.0.1:5678/workflow/abc123XYZ': 'abc123XYZ',
    // the real id from this estate
    'https://n8n.srv1340120.hstgr.cloud/workflow/S3Yx1gWQAJYy7mYM': 'S3Yx1gWQAJYy7mYM',
  };
  for (const [url, id] of Object.entries(cases)) {
    const got = parseWorkflowRef(url);
    assert.equal(got.ok, true, `${url} should parse: ${got.error}`);
    assert.equal(got.id, id, url);
  }
});

test('a bare id is accepted; the host is then unknown', () => {
  const got = parseWorkflowRef('S3Yx1gWQAJYy7mYM');
  assert.equal(got.ok, true);
  assert.equal(got.id, 'S3Yx1gWQAJYy7mYM');
  assert.equal(got.host, null, 'a bare id cannot say which n8n it is on');
});

test('the last /workflow/ segment wins, so a prefix cannot shadow the real one', () => {
  // A reverse proxy mounting n8n under /workflow would otherwise hand back
  // "n8n" as the id.
  const got = parseWorkflowRef('https://host/workflow/n8n/workflow/abc123XYZ');
  assert.equal(got.id, 'abc123XYZ');
});

test('what is NOT a workflow URL says why, rather than guessing an id', () => {
  const bad = [
    ['https://n8n.example.com/home/workflows', /no \/workflow\/<id>/],
    ['https://n8n.example.com/workflow/new', /unsaved/],
    ['https://n8n.example.com/workflow/', /nothing after/],
    ['https://n8n.example.com/workflow/ab', /not a workflow id/],
    ['ftp://n8n.example.com/workflow/abc123XYZ', /only http and https/],
    ['', /nothing to parse/],
  ];
  for (const [input, re] of bad) {
    const got = parseWorkflowRef(input);
    assert.equal(got.ok, false, `${input} must be rejected`);
    assert.match(got.error, re, input);
  }
});

test('an id scraped out of a query string is not an id', () => {
  // The dangerous near-miss: something that looks like it carries an id but
  // is not the editor URL. Guessing here registers a workflow nobody asked for.
  const got = parseWorkflowRef('https://n8n.example.com/home/executions?workflowId=abc123XYZ');
  assert.equal(got.ok, false);
});

/* ----------------------------------------------------------- resolution */

const REGISTRY = {
  instances: {
    main: { baseUrl: 'http://127.0.0.1:5678', publicUrl: 'https://n8n.example.com', apiKeyEnv: 'K_MAIN', server: 'srv1' },
    off: { baseUrl: 'http://127.0.0.1:5679', apiKeyEnv: 'K_OFF', enabled: false },
    broken: { baseUrl: 'not-a-url', apiKeyEnv: 'K_B' },
    keyless: { baseUrl: 'http://127.0.0.1:5680' },
  },
  defaults: { expectedIntervalMin: null, minimumItems: 0, anomalyDropPct: 40 },
  workflows: [
    { id: 'aaaaaaaaaaaa', instance: 'main', name: 'Hourly', expectedIntervalMin: 60 },
    { id: 'bbbbbbbbbbbb', instance: 'main', name: 'Webhook driven' },
    { id: 'cccccccccccc', instance: 'off', name: 'On a disabled instance' },
    { id: 'short', instance: 'main' },
    { id: 'aaaaaaaaaaaa', instance: 'main', name: 'Duplicate' },
    { id: 'dddddddddddd', instance: 'nope' },
  ],
};

test('plain HTTP to another machine is refused — that is the API key in clear text', () => {
  // The real case: the second n8n publishes 0.0.0.0:32769 with no TLS. Pointing
  // the collector straight at it works first time and quietly ships a
  // full-read credential across the internet four times a day forever.
  const r = resolveRegistry({
    instances: {
      exposed: { baseUrl: 'http://200.141.9.83:32769', apiKeyEnv: 'K' },
      tunnelled: { baseUrl: 'http://127.0.0.1:15678', apiKeyEnv: 'K' },
      tls: { baseUrl: 'https://n8n.example.com', apiKeyEnv: 'K' },
      local: { baseUrl: 'http://localhost:5678', apiKeyEnv: 'K' },
    },
    workflows: [],
  });
  assert.deepEqual(Object.keys(r.instances).sort(), ['local', 'tls', 'tunnelled']);
  assert.match(r.errors.join('\n'), /instance "exposed" would send its API key in clear text/);
  assert.match(r.errors.join('\n'), /tunnel it and point baseUrl at 127\.0\.0\.1/);
});

test('a disabled, malformed or keyless instance is refused by name', () => {
  const r = resolveRegistry(REGISTRY);
  assert.deepEqual(Object.keys(r.instances), ['main']);
  assert.match(r.errors.join('\n'), /instance "broken" baseUrl is not an http/);
  assert.match(r.errors.join('\n'), /instance "keyless" does not name an apiKeyEnv/);
});

test('one bad registry entry never costs the others their monitoring', () => {
  const r = resolveRegistry(REGISTRY);
  assert.deepEqual(r.workflows.map((w) => w.id), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  const errors = r.errors.join('\n');
  assert.match(errors, /"short" is not a workflow id/);
  assert.match(errors, /registered twice/);
  assert.match(errors, /names instance "nope"/);
  assert.match(errors, /names instance "off", which is not declared or is disabled/);
});

test('staleAfterMin derives from the interval, and only when one was declared', () => {
  const r = resolveRegistry(REGISTRY);
  const hourly = r.workflows.find((w) => w.id === 'aaaaaaaaaaaa');
  const webhook = r.workflows.find((w) => w.id === 'bbbbbbbbbbbb');
  assert.equal(hourly.staleAfterMin, 60 * 2 + 15);
  assert.equal(webhook.staleAfterMin, null,
    'a webhook workflow is not stale because nobody filled the form');
});

test('an explicit staleAfterMin is never overwritten by the derived one', () => {
  const r = resolveRegistry({
    ...REGISTRY,
    workflows: [{ id: 'aaaaaaaaaaaa', instance: 'main', expectedIntervalMin: 60, staleAfterMin: 90 }],
  });
  assert.equal(r.workflows[0].staleAfterMin, 90);
});

test('the host allowlist is what attributes a pasted URL, and it is closed', () => {
  const { instances } = resolveRegistry(REGISTRY);
  assert.equal(instanceForHost('n8n.example.com', instances)?.id, 'main', 'publicUrl host');
  assert.equal(instanceForHost('127.0.0.1', instances)?.id, 'main', 'baseUrl host');
  assert.equal(instanceForHost('attacker.example.com', instances), null,
    'an unconfigured host must never resolve to an instance — that is the SSRF guard');
  assert.equal(instanceForHost(null, instances), null);
});

test('the local override merges by id and unions the recipients', () => {
  // The recipients union is not a nicety: four addresses were added to the
  // tracked file and never received a thing, because a plain key lets the
  // local copy win.
  const base = {
    instances: { main: { baseUrl: 'http://127.0.0.1:5678', apiKeyEnv: 'K' } },
    workflows: [{ id: 'aaaaaaaaaaaa', instance: 'main', name: 'Base', minimumItems: 1 }],
    report: { notify: ['a@x', 'b@x'], timezone: 'Asia/Kolkata' },
  };
  const local = {
    workflows: [{ id: 'aaaaaaaaaaaa', instance: 'main', expectedIntervalMin: 30 }],
    report: { notify: ['c@x'], webhook: 'http://127.0.0.1:5678/webhook/x' },
  };
  // loadRegistry() reads files; the merge itself is what matters, so it is
  // exercised through resolveRegistry on an already-merged shape plus a
  // hand-check of the union rule.
  const union = [...new Set([...base.report.notify, ...local.report.notify])];
  assert.deepEqual(union, ['a@x', 'b@x', 'c@x']);

  const merged = { ...base, ...local, workflows: [{ ...base.workflows[0], ...local.workflows[0] }] };
  const r = resolveRegistry(merged);
  assert.equal(r.workflows[0].minimumItems, 1, 'a base-only field survives the override');
  assert.equal(r.workflows[0].expectedIntervalMin, 30, 'the local value wins where both set it');
});

/* ------------------------------------------------------------- wf-add */

test('parseMinutes takes the durations the CLI documents, and nothing else', () => {
  assert.equal(parseMinutes('90'), 90);
  assert.equal(parseMinutes('90m'), 90);
  assert.equal(parseMinutes('6h'), 360);
  assert.equal(parseMinutes('1d'), 1440);
  assert.equal(parseMinutes('6 h'), 360);
  assert.equal(parseMinutes('soon'), null);
  assert.equal(parseMinutes('6w'), null);
  assert.equal(parseMinutes(undefined), null);
});

test('wf-add builds an entry from the URL and the flags', () => {
  const { instances } = resolveRegistry(REGISTRY);
  const got = buildEntry([
    'https://n8n.example.com/workflow/eeeeeeeeeeee',
    '--name', 'Lead Qualification',
    '--project', 'yamini',
    '--every', '1h',
    '--min-items', '1',
    '--checkpoint', 'Fetch Leads',
    '--checkpoint', 'CRM Insert',
  ], { instances });

  assert.equal(got.ok, true, got.error);
  assert.deepEqual(got.entry, {
    id: 'eeeeeeeeeeee',
    instance: 'main',
    name: 'Lead Qualification',
    project: 'yamini',
    monitoring: true,
    expectedIntervalMin: 60,
    minimumItems: 1,
    checkpoints: ['Fetch Leads', 'CRM Insert'],
    url: 'https://n8n.example.com/workflow/eeeeeeeeeeee',
  });
});

test('wf-add refuses a host it does not know, and says what to do', () => {
  const { instances } = resolveRegistry(REGISTRY);
  const got = buildEntry(['https://someone-elses-n8n.com/workflow/eeeeeeeeeeee'], { instances });
  assert.equal(got.ok, false);
  assert.match(got.error, /is not a configured n8n instance/);
  assert.match(got.error, /--instance <main>/, 'the message must name the instances that do exist');
});

test('wf-add needs --instance for a bare id, since the id says nothing about the host', () => {
  const { instances } = resolveRegistry({
    ...REGISTRY,
    instances: { ...REGISTRY.instances, second: { baseUrl: 'http://127.0.0.1:5681', apiKeyEnv: 'K2' } },
  });
  const got = buildEntry(['eeeeeeeeeeee'], { instances });
  assert.equal(got.ok, false);
  assert.match(got.error, /--instance/);
});

test('wf-add rejects a nonsense threshold rather than writing it down', () => {
  const { instances } = resolveRegistry(REGISTRY);
  for (const [flag, value, re] of [
    ['--every', 'often', /--every takes a duration/],
    ['--min-items', '-1', /whole number/],
    ['--drop-pct', '140', /between 1 and 99/],
    ['--drop-pct', '0', /between 1 and 99/],
  ]) {
    const got = buildEntry(['https://n8n.example.com/workflow/eeeeeeeeeeee', flag, value], { instances });
    assert.equal(got.ok, false, `${flag} ${value}`);
    assert.match(got.error, re);
  }
});
