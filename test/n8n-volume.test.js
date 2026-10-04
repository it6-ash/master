import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toRow, statusOf, durationOf, resultDataOf, nodeFunnel, errorFrom,
} from '../src/n8n/volume.js';

/* A realistic execution: webhook in, fetch fans out, filter drops some, the
   mailer at the end emits one. This shape is the whole reason `items` is the
   PEAK node output rather than the trigger's or the last node's. */
const execution = (over = {}) => ({
  id: 4821,
  workflowId: 'S3Yx1gWQAJYy7mYM',
  status: 'success',
  finished: true,
  mode: 'trigger',
  startedAt: '2026-10-04T09:00:00.000Z',
  stoppedAt: '2026-10-04T09:00:02.400Z',
  jsonSizeBytes: 88211,
  data: {
    resultData: {
      lastNodeExecuted: 'Notify',
      runData: {
        Webhook: [{ startTime: 1, executionTime: 3, data: { main: [[{ json: {} }]] } }],
        'Fetch Leads': [{ startTime: 4, executionTime: 1800, data: { main: [Array.from({ length: 5240 }, () => ({ json: {} }))] } }],
        Filter: [{ startTime: 1810, executionTime: 40, data: { main: [Array.from({ length: 4812 }, () => ({ json: {} }))] } }],
        'CRM Insert': [{ startTime: 1860, executionTime: 480, data: { main: [Array.from({ length: 4701 }, () => ({ json: {} }))] } }],
        Notify: [{ startTime: 2350, executionTime: 50, data: { main: [[{ json: {} }]] } }],
      },
    },
  },
  ...over,
});

test('data volume is the widest point in the chain, not either end of it', () => {
  const row = toRow(execution());
  assert.equal(row.items, 5240, 'the peak single-node output IS the volume that went through');
  assert.equal(row.inputItems, 1, 'the webhook delivered one item');
  assert.equal(row.outputItems, 1, 'the mailer emitted one item');
  assert.equal(row.volumeSource, 'node-data');
  // Either end alone would report this five-thousand-lead run as "1 item".
  assert.notEqual(row.items, row.inputItems);
  assert.notEqual(row.items, row.outputItems);
});

test('items are summed across a node that ran many times', () => {
  const row = toRow(execution({
    data: {
      resultData: {
        runData: {
          Loop: [
            { executionTime: 10, data: { main: [[{ json: {} }, { json: {} }]] } },
            { executionTime: 10, data: { main: [[{ json: {} }]] } },
            { executionTime: 10, data: { main: [[{ json: {} }, { json: {} }, { json: {} }]] } },
          ],
        },
      },
    },
  }));
  assert.equal(row.items, 6, 'three batches of 2, 1 and 3');
  assert.equal(row.nodes.Loop.ms, 30);
});

test('both branches of a two-output node count — an IF produces data on each', () => {
  const row = toRow(execution({
    data: {
      resultData: {
        runData: {
          IF: [{ executionTime: 5, data: { main: [[{ json: {} }, { json: {} }], [{ json: {} }]] } }],
        },
      },
    },
  }));
  assert.equal(row.items, 3);
});

test('an unconnected branch is null and must not throw', () => {
  const row = toRow(execution({
    data: { resultData: { runData: { IF: [{ data: { main: [null, [{ json: {} }]] } }] } } },
  }));
  assert.equal(row.items, 1);
});

test('checkpoints distinguish "produced nothing" from "never ran"', () => {
  const row = toRow(execution(), { checkpoints: ['Fetch Leads', 'CRM Insert', 'Nonexistent Node'] });
  assert.equal(row.checkpoints['Fetch Leads'], 5240);
  assert.equal(row.checkpoints['CRM Insert'], 4701);
  assert.equal(row.checkpoints['Nonexistent Node'], null,
    'a node that did not run is null, not 0 — they are different findings');
});

/* ------------------------------------------------- honest absence of data */

test('with no node data, bytes are recorded and items are left absent', () => {
  const row = toRow(execution({ data: undefined, dataTooLargeToDisplay: true }));
  assert.equal(row.volumeSource, 'bytes');
  assert.equal(row.bytes, 88211, 'jsonSizeBytes needs no node data, so this series is complete');
  assert.equal(row.items, undefined, 'an item count is NEVER estimated');
  assert.equal(row.inputItems, undefined);
  assert.equal(row.dataWithheld, 'too large');
});

test('with neither node data nor a size, both are absent rather than zero', () => {
  const row = toRow(execution({ data: undefined, jsonSizeBytes: undefined }));
  assert.equal(row.volumeSource, 'none');
  assert.equal(row.items, undefined);
  assert.equal(row.bytes, undefined, '0 bytes would claim an empty payload was observed');
});

test('a flatted payload arriving as a JSON STRING is decoded too', () => {
  // The database column is TEXT. Whether it reaches here already parsed or
  // still as a string must not change the answer.
  const row = toRow(execution({ data: JSON.stringify([{ resultData: '1' }, { runData: '2' }, {}]) }));
  assert.equal(row.volumeSource, 'node-data');
  assert.equal(row.items, 0, 'decoded cleanly and found no nodes, which is 0 — not "unknown"');
});

test('a JSON-string payload from an older instance is still read', () => {
  const row = toRow(execution({ data: JSON.stringify(execution().data) }));
  assert.equal(row.items, 5240);
  assert.equal(row.volumeSource, 'node-data');
});

/* --------------------------------------------------------------- status */

test('status falls back to finished plus an error for instances that send none', () => {
  // n8n added `status` to the executions endpoint around 1.116. Before that
  // the only signals were `finished` and the payload's error.
  assert.equal(statusOf({ status: 'success' }), 'success');
  assert.equal(statusOf({ status: 'crashed' }), 'error', 'a crash is a failure, not an unknown');
  assert.equal(statusOf({ status: 'canceled' }), 'canceled');
  assert.equal(statusOf({ status: 'waiting' }), 'running');
  assert.equal(statusOf({ finished: true }), 'success');
  assert.equal(statusOf({ finished: false, stoppedAt: '2026-10-04T09:00:02Z' }), 'error',
    'stopped without finishing is a failure');
  assert.equal(statusOf({ finished: false }), 'running');
  assert.equal(statusOf({ finished: true, data: { resultData: { error: { message: 'boom' } } } }), 'error',
    'an error in the payload beats a finished flag');
});

test('duration needs both ends and never goes negative', () => {
  assert.equal(durationOf({ startedAt: '2026-10-04T09:00:00Z', stoppedAt: '2026-10-04T09:00:02.4Z' }), 2400);
  assert.equal(durationOf({ startedAt: '2026-10-04T09:00:00Z' }), null, 'a running execution has no duration');
  assert.equal(durationOf({ startedAt: '2026-10-04T09:00:02Z', stoppedAt: '2026-10-04T09:00:00Z' }), null);
  assert.equal(durationOf({}), null);
});

test('resultDataOf tolerates every wrapper and refuses the rest', () => {
  assert.ok(resultDataOf(execution()));
  assert.equal(resultDataOf({ data: null }), null);
  assert.equal(resultDataOf({ data: 'not json' }), null);
  assert.equal(resultDataOf({ data: { } }), null);
  assert.equal(resultDataOf(undefined), null);
});

/* ---------------------------------------------------------------- errors */

test('the failed node and the message come off the payload, redacted', () => {
  const row = toRow(execution({
    status: 'error',
    finished: false,
    data: {
      resultData: {
        lastNodeExecuted: 'CRM Insert',
        error: {
          message: 'Request failed: POST https://crm.example.com?apikey=sk-proj-abcdefghijklmnopqrstuvwxyz0123',
          node: { name: 'CRM Insert' },
        },
        runData: { Webhook: [{ data: { main: [[{ json: {} }]] } }] },
      },
    },
  }));
  assert.equal(row.status, 'error');
  assert.equal(row.failedNode, 'CRM Insert');
  assert.match(row.error, /\[REDACTED:openai-key\]/,
    'n8n error text quotes the failing request, and that request carries keys. This page is public.');
  assert.doesNotMatch(row.error, /sk-proj-abcdef/);
});

test('an error with no node named falls back to the last node that ran', () => {
  const got = errorFrom(
    { lastNodeExecuted: 'Notify', error: { message: 'timeout' } },
    { status: 'error' },
  );
  assert.equal(got.failedNode, 'Notify');
  assert.equal(got.error, 'timeout');
});

test('a failure with no message still says something actionable', () => {
  const got = errorFrom({}, { status: 'error', stoppedAt: '2026-10-04T09:00:02Z' });
  assert.match(got.error, /stopped without finishing/);
});

test('a success is not given an error just because none was recorded', () => {
  const got = errorFrom({}, { status: 'success' });
  assert.equal(got.error, null);
  assert.equal(got.failedNode, null);
});

/* ---------------------------------------------------------------- funnel */

test('the funnel reads in run order and names where the data went', () => {
  const rows = [toRow(execution()), toRow(execution({ id: 4822 }))];
  const funnel = nodeFunnel(rows);

  assert.deepEqual(funnel.stages.map((s) => s.node),
    ['Webhook', 'Fetch Leads', 'Filter', 'CRM Insert', 'Notify'],
    'stage order is execution order, taken from the newest successful run');
  assert.equal(funnel.executions, 2);

  const filter = funnel.stages.find((s) => s.node === 'Filter');
  assert.equal(filter.items, 4812 * 2, 'summed across both executions');
  assert.equal(filter.dropped, (5240 - 4812) * 2, 'measured against the stage before it');
  assert.equal(funnel.stages[0].dropped, null, 'the first stage has nothing to be measured against');
});

test('a stage that produces more than it received is a gain, not a negative loss', () => {
  const row = toRow(execution({
    data: {
      resultData: {
        lastNodeExecuted: 'Split',
        runData: {
          Trigger: [{ data: { main: [[{ json: {} }]] } }],
          Split: [{ data: { main: [Array.from({ length: 40 }, () => ({ json: {} }))] } }],
        },
      },
    },
  }));
  const funnel = nodeFunnel([row]);
  assert.equal(funnel.stages[1].dropped, -39, 'a negative drop is the caller\'s cue to say "gained"');
});

test('a funnel is not drawn from failed runs or from rows with no node detail', () => {
  assert.equal(nodeFunnel([]), null);
  assert.equal(nodeFunnel([{ status: 'success', volumeSource: 'bytes', bytes: 10 }]), null);
  assert.equal(nodeFunnel([toRow(execution({ status: 'error' }))]), null,
    'a half-finished chain would read as a collapse at whichever node broke');
});

test('a node added since an older run does not reorder the funnel', () => {
  const current = toRow(execution());
  const older = toRow(execution({
    id: 4000,
    data: {
      resultData: {
        lastNodeExecuted: 'Notify',
        runData: {
          Webhook: [{ data: { main: [[{ json: {} }]] } }],
          'Removed Node': [{ data: { main: [Array.from({ length: 999 }, () => ({ json: {} }))] } }],
          Notify: [{ data: { main: [[{ json: {} }]] } }],
        },
      },
    },
  }));
  const funnel = nodeFunnel([current, older]);
  assert.equal(funnel.stages.some((s) => s.node === 'Removed Node'), false,
    'the current shape is the shape; a vanished node must not reappear as a stage');
  assert.equal(funnel.stages.find((s) => s.node === 'Webhook').runs, 2);
});

/* ------------------------------------------------------------- flatted */

test('n8n\u2019s flatted payload decodes to the same shape the API would have returned', () => {
  // n8n stores execution_data.data with `flatted`: index 0 is the root and
  // every string in a value position is the decimal index of its real value.
  // Reading the database directly means meeting it, and without the decoder
  // there are no item counts at all.
  const flat = [
    { resultData: '1' },                       // 0: root
    { runData: '2', lastNodeExecuted: '7' },   // 1: resultData
    { Webhook: '3', Fetch: '5' },              // 2: runData
    ['4'],                                     // 3: Webhook runs
    { data: '9' },                             // 4: run
    ['6'],                                     // 5: Fetch runs
    { data: '11' },                            // 6: run
    'Fetch',                                   // 7: a string value
    null,
    { main: '10' },                            // 9
    [['13']],                                  // 10: one branch, one item
    { main: '12' },                            // 11
    [['13', '13', '13']],                      // 12: three items
    { json: '14' },                            // 13: shared item
    {},                                        // 14
  ];
  const row = toRow({ id: 7, status: 'success', startedAt: '2026-10-04T09:00:00Z', stoppedAt: '2026-10-04T09:00:01Z', data: flat });

  assert.equal(row.volumeSource, 'node-data');
  assert.equal(row.nodes.Webhook.items, 1);
  assert.equal(row.nodes.Fetch.items, 3, 'the shared item is counted each time it appears');
  assert.equal(row.items, 3, 'peak node output');
  assert.equal(row.outputItems, 3, 'lastNodeExecuted resolved through its string index');
});

test('a self-referencing payload terminates instead of recursing forever', () => {
  // n8n writes parent pointers, which is the whole reason flatted exists.
  const cyclic = [{ self: '0', resultData: '1' }, { runData: '2' }, { A: '3' }, ['4'], { data: '5' }, { main: '6' }, [[]]];
  const row = toRow({ id: 8, status: 'success', data: cyclic });
  assert.equal(row.volumeSource, 'node-data');
  assert.equal(row.nodes.A.items, 0);
});

test('garbage in the data column is declined, not half-read', () => {
  assert.equal(toRow({ id: 9, status: 'success', data: [] }).volumeSource, 'none');
  assert.equal(toRow({ id: 10, status: 'success', data: ['not-an-object'] }).volumeSource, 'none');
});
