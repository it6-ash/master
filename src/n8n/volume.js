/**
 * Turning an n8n execution into numbers, without inventing any.
 *
 * This is the file the whole module stands on, so it is explicit about what
 * each figure means and where it came from. There is no `data_volume` field in
 * the n8n API; every item count here is derived from the node run data, and
 * every row records a `volumeSource` saying which route produced it:
 *
 *   node-data   items counted from data.resultData.runData. Exact.
 *   bytes       n8n reported jsonSizeBytes but withheld the node data (too
 *               large, redacted, or pruned). Bytes are real, items are null.
 *   none        neither available. Both null.
 *
 * A row with volumeSource 'bytes' or 'none' never gets an item count guessed
 * for it, and the dashboard counts how many rows in a window are covered so it
 * can say "items on 412 of 418 executions" rather than implying it saw all of
 * them. That distinction is the difference between an observability tool and a
 * decorative one.
 */

import { redactString } from '../lib/redact.js';
import { tallyAll } from './dimensions.js';

/* -------------------------------------------------------------- items */

/**
 * Items on one output of one node run.
 *
 * `data.main` is an array of output branches; each branch is an array of items,
 * or null when that branch is not connected. A node with two outputs (an IF)
 * contributes both, because both are data it produced.
 */
function itemsInRun(run) {
  const branches = run?.data?.main;
  if (!Array.isArray(branches)) return 0;
  let total = 0;
  for (const branch of branches) if (Array.isArray(branch)) total += branch.length;
  return total;
}

/**
 * A node can run many times — once per loop iteration, once per batch. Items
 * are summed across runs, because that is how much data passed through it.
 */
function itemsForNode(runs) {
  if (!Array.isArray(runs)) return 0;
  let total = 0;
  for (const run of runs) total += itemsInRun(run);
  return total;
}

function msForNode(runs) {
  if (!Array.isArray(runs)) return null;
  let total = 0;
  let seen = false;
  for (const run of runs) {
    if (Number.isFinite(run?.executionTime)) { total += run.executionTime; seen = true; }
  }
  return seen ? total : null;
}

/* ------------------------------------------------------- execution data */

/**
 * Get at `data.resultData`, whatever wrapper this n8n version used.
 *
 * Older instances serialise the execution payload as a JSON string, and some
 * store it in the `flatted` circular-reference encoding — an array whose first
 * element indexes the rest. There is no way to read that without the flatted
 * decoder, and this repo has no dependencies, so it is detected and declined
 * rather than half-parsed into wrong numbers.
 */
export function resultDataOf(execution) {
  let data = execution?.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return null; }
  }
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data)) data = unflatten(data);
  if (!data || typeof data !== 'object') return null;
  const result = data.resultData;
  if (!result || typeof result !== 'object') return null;
  return result;
}

/**
 * Decode n8n's flatted execution payload.
 *
 * n8n stores `execution_data.data` with `flatted`, which turns a structure
 * with shared and circular references into a flat array: index 0 is the root,
 * and every string in a value position is the decimal index of its real value.
 * A run's items appear once and are pointed at from several places, which is
 * why the format exists at all.
 *
 * Reading the database directly means meeting it — the public API unflattens
 * before it answers, and this is the path that has no API. Twenty lines of
 * stdlib beats a dependency, and the alternative is no item counts at all.
 *
 * ponytail: cycles are resolved via the `seen` map, which is also what keeps
 * this from recursing forever on n8n's parent-pointer references.
 */
export function unflatten(input) {
  if (!Array.isArray(input) || !input.length) return null;
  const seen = new Map();

  const hydrate = (i) => {
    if (seen.has(i)) return seen.get(i);
    const raw = input[i];
    if (raw === null || typeof raw !== 'object') { seen.set(i, raw); return raw; }

    const out = Array.isArray(raw) ? [] : {};
    // Registered BEFORE recursing, so a reference back to this node during its
    // own construction resolves to the same object rather than looping.
    seen.set(i, out);
    for (const [key, value] of Object.entries(raw)) out[key] = resolve(value);
    return out;
  };

  /**
   * Only strings are indices; numbers, booleans and null are stored inline.
   *
   * A nested array or object is walked rather than copied. Canonical flatted
   * gives every container its own entry, so this branch should not fire — but
   * when it does, passing the value through verbatim leaves raw index strings
   * sitting where items should be, and `item.json` is then undefined for every
   * one of them. The symptom is an execution that reports zero items with no
   * error anywhere, which is indistinguishable from a workflow that genuinely
   * moved nothing.
   */
  function resolve(value) {
    if (typeof value === 'string') {
      const at = Number(value);
      return Number.isInteger(at) && at >= 0 && at < input.length ? hydrate(at) : value;
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = resolve(v);
      return out;
    }
    return value;
  }

  try {
    return hydrate(0);
  } catch {
    return null;
  }
}

/** ms between startedAt and stoppedAt, or null if either is missing. */
export function durationOf(execution) {
  const from = Date.parse(execution?.startedAt ?? '');
  const to = Date.parse(execution?.stoppedAt ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const ms = to - from;
  return ms >= 0 ? ms : null;
}

/**
 * Status, with a fallback for instances that do not send one.
 *
 * n8n added `status` to the executions endpoint around 1.116; before that the
 * only signal was `finished` plus the presence of an error in the payload.
 * Normalised to the four states this module reasons about, so a `crashed` run
 * counts as a failure rather than falling through every rule as "unknown".
 */
export function statusOf(execution) {
  const raw = String(execution?.status ?? '').toLowerCase();
  if (raw === 'success') return 'success';
  if (raw === 'error' || raw === 'crashed' || raw === 'canceled') return raw === 'canceled' ? 'canceled' : 'error';
  if (raw === 'waiting' || raw === 'running' || raw === 'new') return 'running';

  const result = resultDataOf(execution);
  if (result?.error) return 'error';
  if (execution?.finished === true) return 'success';
  if (execution?.stoppedAt) return 'error'; // stopped without finishing
  return 'running';
}

/* ------------------------------------------------------------ the row */

/**
 * One stored row from one execution. Metadata always; item counts only when
 * the node data actually arrived.
 *
 * @param {object} execution    an /executions or /executions/:id response
 * @param {{ checkpoints?: string[] }} [opts]
 */
export function toRow(execution, { checkpoints = [], dimensions = [], salt = null } = {}) {
  const result = resultDataOf(execution);
  const runData = result?.runData && typeof result.runData === 'object' ? result.runData : null;

  const row = {
    id: String(execution?.id ?? ''),
    status: statusOf(execution),
    startedAt: execution?.startedAt ?? execution?.createdAt ?? null,
    stoppedAt: execution?.stoppedAt ?? null,
    ms: durationOf(execution),
    mode: execution?.mode ?? null,
  };
  if (execution?.retryOf != null) row.retryOf = String(execution.retryOf);
  if (execution?.retrySuccessId != null) row.retrySuccessId = String(execution.retrySuccessId);

  // Bytes come from the list response and need no node data, so this series is
  // complete even when item counts are not.
  const bytes = Number(execution?.jsonSizeBytes);
  if (Number.isFinite(bytes) && bytes >= 0) row.bytes = bytes;
  const binary = Number(execution?.binaryDataSizeBytes);
  if (Number.isFinite(binary) && binary > 0) row.binaryBytes = binary;

  if (!runData) {
    row.volumeSource = row.bytes !== undefined ? 'bytes' : 'none';
    if (execution?.dataTooLargeToDisplay) row.dataWithheld = 'too large';
    // The error still matters even with no node data; it is the one field a
    // failed execution exists to carry.
    const failure = errorFrom(result, execution);
    if (failure.failedNode) row.failedNode = failure.failedNode;
    if (failure.error) row.error = failure.error;
    return row;
  }

  const names = Object.keys(runData);
  const nodes = {};
  let peak = 0;
  let nodeItems = 0;
  for (const name of names) {
    const items = itemsForNode(runData[name]);
    const ms = msForNode(runData[name]);
    nodes[name] = ms === null ? { items } : { items, ms };
    nodeItems += items;
    if (items > peak) peak = items;
  }

  // Insertion order of runData is execution order, so the first key is the
  // trigger. That is what "items in" means: what arrived from outside.
  row.inputItems = names.length ? itemsForNode(runData[names[0]]) : 0;

  // And the last node that actually ran is what "items out" means. n8n names
  // it explicitly; falling back to the final key covers a payload that does not.
  const lastNode = typeof result.lastNodeExecuted === 'string' && runData[result.lastNodeExecuted]
    ? result.lastNodeExecuted
    : names[names.length - 1];
  row.outputItems = lastNode ? itemsForNode(runData[lastNode]) : 0;

  // The headline volume figure is the PEAK single-node output, not the
  // trigger's and not the last node's. A webhook emits one item while the
  // fetch behind it emits five thousand, and a mailer at the end emits one
  // again — so both ends understate the run by three orders of magnitude.
  // The widest point is how much data went through.
  row.items = peak;
  row.nodeItems = nodeItems;
  row.nodeCount = names.length;
  row.volumeSource = 'node-data';
  row.nodes = nodes;

  if (checkpoints.length) {
    const marks = {};
    for (const name of checkpoints) {
      // A checkpoint naming a node that did not run in this execution is
      // recorded as null, not 0. "The CRM insert produced nothing" and "the
      // CRM insert never happened" are different findings.
      marks[name] = Object.hasOwn(nodes, name) ? nodes[name].items : null;
    }
    row.checkpoints = marks;
  }

  // What was IN the items, where a dimension has been configured. Counts and
  // pseudonyms only — see the header of dimensions.js for why there is no mode
  // that stores message content.
  if (dimensions.length) {
    const dims = tallyAll(runData, dimensions, { salt });
    if (dims) row.dimensions = dims;
  }

  const failure = errorFrom(result, execution);
  if (failure.failedNode) row.failedNode = failure.failedNode;
  if (failure.error) row.error = failure.error;

  return row;
}

/**
 * Which node broke, and why, in one sentence.
 *
 * Redacted through the same table ingest uses: an n8n error message routinely
 * quotes the request that failed, and that request routinely carries an API
 * key. This page is served publicly.
 */
export function errorFrom(result, execution) {
  const err = result?.error;
  const lastNode = typeof result?.lastNodeExecuted === 'string' ? result.lastNodeExecuted : null;
  const failedNode = err?.node?.name ?? err?.nodeName ?? (err ? lastNode : null);

  let message = err?.message ?? err?.description ?? null;
  if (!message && statusOf(execution) === 'error') {
    message = execution?.stoppedAt ? 'the execution stopped without finishing' : 'failed with no message recorded';
  }
  if (!message) return { failedNode: failedNode ?? null, error: null };

  return {
    failedNode: failedNode ?? null,
    error: redactString(String(message).replace(/\s+/g, ' ').trim().slice(0, 240)).text,
  };
}

/**
 * The node funnel: how many items each stage emitted, and where they vanished.
 *
 * Built from the newest rows that still carry node detail, in the order the
 * nodes ran. `dropped` is against the previous stage, so a negative number —
 * a stage producing MORE than it received, as a split or an item-per-row node
 * does — is reported as a gain rather than a nonsensical loss.
 *
 * @param {object[]} rows  newest first
 */
export function nodeFunnel(rows, { sample = 25 } = {}) {
  const withNodes = rows.filter((r) => r.nodes && r.status === 'success').slice(0, sample);
  if (!withNodes.length) return null;

  // Order comes from the most recent successful execution; totals come from
  // every sampled one. A node added last week must not reorder older runs.
  const order = Object.keys(withNodes[0].nodes);
  const totals = new Map(order.map((n) => [n, { node: n, items: 0, ms: 0, runs: 0 }]));

  for (const row of withNodes) {
    for (const [name, stats] of Object.entries(row.nodes)) {
      const entry = totals.get(name);
      if (!entry) continue; // present in an older run, gone from the current shape
      entry.items += stats.items ?? 0;
      entry.ms += stats.ms ?? 0;
      entry.runs += 1;
    }
  }

  const stages = [...totals.values()].filter((s) => s.runs > 0);
  let previous = null;
  for (const stage of stages) {
    stage.dropped = previous === null ? null : previous.items - stage.items;
    previous = stage;
  }

  return { stages, executions: withNodes.length };
}
