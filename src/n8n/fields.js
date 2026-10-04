#!/usr/bin/env node
/**
 * npm run wf-fields -- <workflow id> [--node "Node Name"]
 *
 * What fields a workflow's nodes actually emit, so a dimension can be
 * configured from what is there rather than from a guess at a field name.
 *
 * It prints SHAPE ONLY — field names, how often each is present, how many
 * distinct values it takes, and whether the values look personal. It never
 * prints a value. That is what makes it safe to point at the Yamini workflows,
 * whose items are real WhatsApp conversations.
 *
 * The recommendation in the last column is the useful part:
 *
 *   group    low-cardinality and impersonal — a bucket id, a status, an intent
 *            label. Raw values are kept and charted.
 *   distinct high-cardinality or personal — a phone number, a contact id. Only
 *            a salted pseudonym is kept, which counts people without
 *            identifying them.
 *   skip     free text. There is no mode that stores it.
 */

import path from 'node:path';

import { ROOT, abs, readJson } from '../lib/fsx.js';
import { resolveRegistry } from './registry.js';
import * as apiDriver from './client.js';
import * as sqliteDriver from './sqlite.js';
import { resultDataOf } from './volume.js';
import { describeFields, itemsOf } from './dimensions.js';

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const nodeArg = (() => {
  const i = args.indexOf('--node');
  return i !== -1 ? args[i + 1] : null;
})();

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (color ? `[${c}m${s}[0m` : s);
const dim = (s) => paint('2', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const green = (s) => paint('32', s);

export async function run() {
  const registry = resolveRegistry();
  const id = only[0];
  if (!id) {
    process.stderr.write('Which workflow? npm run wf-fields -- <workflow id> [--node "Node Name"]\n\n'
      + `Registered: ${registry.workflows.map((w) => `${w.id} (${w.name ?? '?'})`).join('\n            ')}\n`);
    return 2;
  }

  const workflow = registry.workflows.find((w) => w.id === id || w.name === id);
  if (!workflow) {
    process.stderr.write(`✗ ${id} is not registered. npm run wf-add -- --list\n`);
    return 2;
  }
  const instance = registry.instances[workflow.instance];

  process.stdout.write(`\n${workflow.name ?? workflow.id} ${dim(`· ${workflow.instance}`)}\n`);

  // The newest successful execution carrying node data is enough to describe
  // the shape. Walking the whole history to describe field names would be a
  // lot of transfer for an answer that does not change.
  const driver = instance.source === 'sqlite' ? sqliteDriver : apiDriver;
  const { executions } = await driver.fetchExecutions(instance, workflow.id, { limit: 20 });
  if (!executions.length) {
    process.stdout.write(`${yellow('!')} no executions to look at yet.\n`);
    return 0;
  }

  let runData = null;
  let usedId = null;
  for (const e of executions) {
    const got = await driver.fetchExecutionDetail(instance, e.id);
    const result = resultDataOf(got?.execution);
    if (result?.runData && Object.keys(result.runData).length) {
      runData = result.runData;
      usedId = e.id;
      break;
    }
  }
  if (!runData) {
    process.stdout.write(`${yellow('!')} none of the newest ${executions.length} executions still carry node data —`
      + ' n8n prunes it after about two weeks.\n');
    return 0;
  }

  process.stdout.write(dim(`from execution ${usedId}\n`));

  const nodes = nodeArg ? [nodeArg] : Object.keys(runData);
  for (const node of nodes) {
    const fields = describeFields(runData, node);
    const count = itemsOf(runData, node).length;
    process.stdout.write(`\n  ${node} ${dim(`· ${count} item${count === 1 ? '' : 's'}`)}\n`);
    if (!fields) {
      process.stdout.write(dim('    emitted nothing in this execution\n'));
      continue;
    }
    process.stdout.write(dim('    field                          present  distinct  suggestion\n'));
    for (const f of fields.slice(0, 24)) {
      const flag = f.personal ? red('personal') : '';
      const suggest = f.suggest.startsWith('skip') ? dim(f.suggest)
        : f.suggest === 'distinct' ? yellow(f.suggest) : green(f.suggest);
      process.stdout.write(`    ${f.field.slice(0, 30).padEnd(30)} ${String(`${f.presentPct}%`).padStart(7)}`
        + `  ${String(f.distinct).padStart(8)}  ${suggest} ${flag}\n`);
    }
  }

  process.stdout.write(`\n${dim('No value was read out of any field — only names, counts and shape.')}\n`
    + `${dim('Add one to config/n8n.json under the workflow:')}\n`
    + `  "dimensions": [{ "node": "${nodes[0]}", "field": "<field>", "label": "<what to call it>", "mode": "group" }]\n`
    + `${dim('mode "distinct" pseudonymises, and needs $KW_DIMENSION_SALT set.')}\n`);
  return 0;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(ROOT, 'src', 'n8n', 'fields.js')) {
  process.exitCode = await run();
}
