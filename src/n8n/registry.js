#!/usr/bin/env node
/**
 * The workflow registry: which n8n instances exist and which workflows are
 * being watched.
 *
 *   npm run wf-add -- https://n8n.example.com/workflow/abc123   register one
 *   npm run wf-add -- --list                                    show the registry
 *
 * Two layers, the same way check.js loads its config and for the same reason:
 *
 *   config/n8n.example.json  TRACKED. The real registry. A workflow added here
 *                            reaches srv1340120 on the next pull and starts
 *                            being collected without anyone copying a file.
 *   config/n8n.json          git-ignored OVERRIDE. Webhook tokens and anything
 *                            else genuinely secret. Workflows merge by id with
 *                            the local copy winning; `notify` is a union,
 *                            because an address list is additive by nature.
 *
 * No API key is ever read from either file. A key lives in the environment
 * variable the instance names, is used server-side only, and never reaches
 * data/ or the page.
 */

import path from 'node:path';
import fs from 'node:fs';

import { ROOT, abs, rel, readJson } from '../lib/fsx.js';

/** The same id shape ingest/n8n-list.js accepts, so the two agree on what an id is. */
export const WORKFLOW_ID_RE = /^[A-Za-z0-9_-]{8,36}$/;

/* --------------------------------------------------------- URL parsing */

/**
 * Pull a workflow id out of whatever the user pasted.
 *
 * Deliberately not one regex over the whole URL. n8n puts the editor at
 * /workflow/<id>, but that path is not the only shape in the wild:
 *
 *   https://host/workflow/abc123                       the common case
 *   https://host/workflow/abc123/executions/4821       linked from an execution
 *   https://host/projects/P1/workflow/abc123           project-scoped editor
 *   https://host/n8n/workflow/abc123                   behind N8N_PATH
 *   https://tenant.app.n8n.cloud/workflow/abc123       n8n Cloud
 *   abc123                                             a bare id
 *
 * So: find the LAST path segment called `workflow` and take the one after it.
 * That survives a prefix in front and anything appended behind, and it does not
 * guess — a URL with no /workflow/<id> in it returns an error naming what was
 * wrong rather than an id scraped out of the query string.
 *
 * @param {string} input
 * @returns {{ ok: true, id: string, host: string|null, origin: string|null }
 *          | { ok: false, error: string }}
 */
export function parseWorkflowRef(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'nothing to parse' };

  // A bare id, pasted straight out of the n8n list.
  if (WORKFLOW_ID_RE.test(raw) && !raw.includes('/') && !raw.includes('.')) {
    return { ok: true, id: raw, host: null, origin: null };
  }

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: `not a URL and not a workflow id: "${raw.slice(0, 60)}"` };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, error: `only http and https are accepted, not ${url.protocol}` };
  }

  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const at = segments.lastIndexOf('workflow');
  if (at === -1) {
    return {
      ok: false,
      error: `no /workflow/<id> in ${url.pathname} — paste the URL from the n8n editor`
        + ' with the workflow open, or pass the id on its own',
    };
  }

  const id = segments[at + 1];
  if (!id) return { ok: false, error: `nothing after /workflow/ in ${url.pathname}` };
  // n8n's own URL for an unsaved workflow. Registering it would monitor an id
  // that can never execute.
  if (id === 'new') return { ok: false, error: 'that is the URL of an unsaved workflow (/workflow/new)' };
  if (!WORKFLOW_ID_RE.test(id)) {
    return { ok: false, error: `"${id.slice(0, 40)}" is not a workflow id (8-36 of A-Z a-z 0-9 _ -)` };
  }

  return { ok: true, id, host: url.hostname.toLowerCase(), origin: url.origin };
}

/* ------------------------------------------------------------ config */

const DEFAULTS = {
  expectedIntervalMin: null,
  staleAfterMin: null,
  minimumItems: 0,
  anomalyDropPct: 40,
  consecutiveFailures: 3,
  failureRatePct: 10,
  nodeDetailBudget: 150,
};

const RETENTION = {
  rawDays: 30, maxRows: 5000, bucketDays: 400, keepNodeDetail: 200,
};

/**
 * Tracked base, git-ignored override on top. Same merge rules as
 * loadCheckConfig(), including the recipients union — that bug cost four
 * people their copy of the daily mail once already.
 */
export function loadRegistry() {
  const base = readJson(abs('config', 'n8n.example.json'));
  const local = readJson(abs('config', 'n8n.json'));
  const b = base.ok ? base.value : {};
  const l = local.ok ? local.value : {};

  const merged = { ...b, ...l };
  merged.instances = { ...(b.instances ?? {}) };
  for (const [id, inst] of Object.entries(l.instances ?? {})) {
    merged.instances[id] = { ...merged.instances[id], ...inst };
  }

  const byId = new Map((b.workflows ?? []).map((w) => [w.id, w]));
  for (const w of l.workflows ?? []) byId.set(w.id, { ...byId.get(w.id), ...w });
  merged.workflows = [...byId.values()];

  merged.defaults = { ...DEFAULTS, ...(b.defaults ?? {}), ...(l.defaults ?? {}) };
  merged.retention = { ...RETENTION, ...(b.retention ?? {}), ...(l.retention ?? {}) };

  merged.report = { ...(b.report ?? {}), ...(l.report ?? {}) };
  merged.report.alerts = { ...(b.report?.alerts ?? {}), ...(l.report?.alerts ?? {}) };
  merged.report.include = { ...(b.report?.include ?? {}), ...(l.report?.include ?? {}) };
  for (const key of ['notify', 'cc']) {
    const both = [...new Set([...[b.report?.[key] ?? []].flat(), ...[l.report?.[key] ?? []].flat()])];
    merged.report[key] = both.filter(Boolean);
  }

  // Who may sign in. A UNION, like the recipient lists and for the same
  // reason: adding somebody must not require editing two files, and the
  // failure mode of a union is "they still have access", which is visible,
  // rather than "they silently never got any", which is not.
  //
  // Removing somebody therefore has to be done in both files. That is the
  // rarer operation and the one worth making deliberate.
  merged.admin = {
    allowedEmails: [...new Set([
      ...[b.admin?.allowedEmails ?? []].flat(),
      ...[l.admin?.allowedEmails ?? []].flat(),
    ])].map((e) => String(e).trim().toLowerCase()).filter(Boolean),
    allowedDomain: l.admin?.allowedDomain ?? b.admin?.allowedDomain ?? null,
  };

  return merged;
}

/**
 * Every monitored workflow with its thresholds resolved, and every reason a
 * registration was rejected.
 *
 * Rejections are returned rather than thrown: one bad entry must not stop the
 * other twelve being collected, and a registry that silently drops a workflow
 * is how monitoring stops without telling anyone.
 *
 * @returns {{ instances: object, workflows: object[], errors: string[], retention: object, report: object }}
 */
export function resolveRegistry(input = loadRegistry()) {
  const errors = [];
  const instances = {};
  // The floor is guaranteed HERE as well as in loadRegistry(), so a partial
  // object — a test fixture, a hand-written config missing a `defaults` block —
  // still comes out with every threshold present. A missing threshold reads as
  // `undefined` downstream, and `undefined > 60` is false: the rule silently
  // never fires, which is the worst possible failure for a monitoring default.
  const registry = {
    ...input,
    defaults: { ...DEFAULTS, ...(input.defaults ?? {}) },
    retention: { ...RETENTION, ...(input.retention ?? {}) },
  };

  for (const [id, inst] of Object.entries(registry.instances ?? {})) {
    if (inst?.enabled === false) continue;

    // Two ways to read an n8n. `sqlite` goes at the database over SSH and is
    // the one this estate uses — no API key to create or rotate, no public
    // port, and the same SSH-plus-a-read-only-command idiom every other fact
    // on this dashboard already arrives by. `api` is the public REST API,
    // kept because an n8n Cloud instance has no database to reach.
    const source = inst.source ?? 'api';
    if (source === 'sqlite') {
      if (!inst.container && !inst.dbHostPath) {
        errors.push(`instance "${id}" reads sqlite but names neither a container nor a dbHostPath`);
        continue;
      }
      instances[id] = {
        id,
        ...inst,
        source,
        // No baseUrl to attribute a pasted URL by, so the public hostname is
        // the only thing a wf-add URL can be matched against.
        hosts: [inst.publicUrl ? new URL(inst.publicUrl).hostname.toLowerCase() : null].filter(Boolean),
      };
      continue;
    }

    if (!inst?.baseUrl) { errors.push(`instance "${id}" has no baseUrl`); continue; }
    let parsed;
    try { parsed = new URL(inst.baseUrl); } catch { parsed = null; }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      errors.push(`instance "${id}" baseUrl is not an http(s) URL: ${String(inst.baseUrl).slice(0, 60)}`);
      continue;
    }
    if (!inst.apiKeyEnv) { errors.push(`instance "${id}" does not name an apiKeyEnv`); continue; }

    // Plain HTTP to anywhere that is not this machine means the API key — a
    // credential with full read of every execution — crosses the network in
    // clear text on every pass, four times a day, forever. Loopback is fine
    // and is how n8n-main is reached; a tunnel is fine because the SSH layer
    // is the encryption. A bare public IP over http is not.
    const host = parsed.hostname.toLowerCase();
    const isLocal = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    if (parsed.protocol === 'http:' && !isLocal) {
      errors.push(`instance "${id}" would send its API key in clear text to ${host} over plain HTTP.`
        + ' Use https, or tunnel it and point baseUrl at 127.0.0.1.');
      continue;
    }

    instances[id] = {
      id,
      ...inst,
      source,
      baseUrl: inst.baseUrl.replace(/\/+$/, ''),
      // Hosts this instance answers for, used to attribute a pasted URL.
      hosts: [parsed.hostname.toLowerCase(), ...(inst.publicUrl ? [new URL(inst.publicUrl).hostname.toLowerCase()] : [])],
    };
  }

  const seen = new Set();
  const workflows = [];
  for (const entry of registry.workflows ?? []) {
    const id = String(entry?.id ?? '');
    if (!WORKFLOW_ID_RE.test(id)) { errors.push(`"${id.slice(0, 40)}" is not a workflow id`); continue; }
    if (!instances[entry.instance]) {
      errors.push(`workflow ${id} names instance "${entry.instance}", which is not declared or is disabled`);
      continue;
    }
    const key = `${entry.instance}/${id}`;
    if (seen.has(key)) { errors.push(`workflow ${id} is registered twice on ${entry.instance}`); continue; }
    seen.add(key);

    const resolved = { ...registry.defaults, ...entry, id, monitoring: entry.monitoring !== false };
    if (resolved.staleAfterMin == null && resolved.expectedIntervalMin != null) {
      // Two intervals plus a quarter hour. One interval is a false alarm every
      // time a run lands a minute late; three is half a day of silence on an
      // hourly workflow before anybody hears about it.
      resolved.staleAfterMin = resolved.expectedIntervalMin * 2 + 15;
    }
    resolved.checkpoints = [...new Set((entry.checkpoints ?? []).map((c) => String(c).trim()).filter(Boolean))];
    resolved.key = `${entry.instance}__${id}`;
    workflows.push(resolved);
  }

  return {
    instances,
    workflows,
    errors,
    retention: registry.retention ?? RETENTION,
    report: registry.report ?? {},
    // Empty denies everyone. See the note in config/n8n.example.json: a config
    // that failed to load must not be the thing that opens the door.
    admin: {
      allowedEmails: registry.admin?.allowedEmails ?? [],
      allowedDomain: registry.admin?.allowedDomain ?? null,
    },
  };
}

/** The instance a pasted host belongs to, or null. Unknown hosts are never fetched. */
export function instanceForHost(host, instances) {
  if (!host) return null;
  const want = String(host).toLowerCase();
  return Object.values(instances).find((i) => i.hosts?.includes(want)) ?? null;
}

/* --------------------------------------------------------------- CLI */

const USAGE = `
  npm run wf-add -- <n8n workflow URL or id> [options]
  npm run wf-add -- --discover          register every ACTIVE workflow the
                                        estate inventory already knows about

    --instance <id>      which configured n8n instance (required if the URL host
                         does not match one, or more than one is configured)
    --name <text>        display name; defaults to the name n8n reports
    --project <id>       an id under content/projects/, to join the hierarchy
    --every <60m|6h|1d>  expected interval. Omit for webhook-driven workflows
    --min-items <n>      minimum items a successful run should produce
    --stale-after <30m>  override the derived staleness window
    --drop-pct <40>      how far below baseline counts as an anomaly
    --checkpoint <node>  an n8n node name to track separately. Repeatable
    --description <text>
    --no-report          collect it, but leave it out of the email report
    --tracked            write to config/n8n.example.json (the repo copy) instead
                         of config/n8n.json. Use in a checkout you are going to
                         commit; NEVER on the box, where pull.sh reverts it
    --list               print the registry and exit
    --dry-run            print the entry, write nothing
`;

/** "90m" -> 90, "6h" -> 360, "1d" -> 1440, "45" -> 45. null if unparseable. */
export function parseMinutes(input) {
  const m = /^(\d+)\s*(m|h|d)?$/i.exec(String(input ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * { m: 1, h: 60, d: 1440 }[(m[2] ?? 'm').toLowerCase()];
}

function takeFlag(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const value = args[i + 1];
  args.splice(i, value != null && !String(value).startsWith('--') ? 2 : 1);
  return value ?? null;
}

function takeAll(args, flag) {
  const out = [];
  for (;;) {
    const value = takeFlag(args, flag);
    if (value == null) return out;
    out.push(value);
  }
}

/**
 * Build the registry entry from argv. Pure, so the id parsing and the
 * instance attribution are testable without touching the filesystem.
 */
export function buildEntry(argv, { instances, dryRun = false } = {}) {
  const args = [...argv];
  const instanceFlag = takeFlag(args, '--instance');
  const name = takeFlag(args, '--name');
  const project = takeFlag(args, '--project');
  const every = takeFlag(args, '--every');
  const minItems = takeFlag(args, '--min-items');
  const staleAfter = takeFlag(args, '--stale-after');
  const dropPct = takeFlag(args, '--drop-pct');
  const description = takeFlag(args, '--description');
  const checkpoints = takeAll(args, '--checkpoint');
  const noReport = args.includes('--no-report');

  const target = args.find((a) => !a.startsWith('--'));
  if (!target) return { ok: false, error: 'paste the n8n workflow URL' };

  const ref = parseWorkflowRef(target);
  if (!ref.ok) return ref;

  const ids = Object.keys(instances ?? {});
  let instance = instanceFlag;
  if (!instance) {
    const matched = instanceForHost(ref.host, instances ?? {});
    if (matched) instance = matched.id;
    // The single-instance shortcut applies ONLY when the input carried no
    // host. A URL that named somebody else's n8n must not be quietly
    // attributed to ours just because ours is the only one configured — that
    // registers a workflow id against an instance it does not exist on, and
    // the symptom is "no executions", which is indistinguishable from a
    // workflow that never runs.
    else if (!ref.host && ids.length === 1) instance = ids[0];
  }
  if (!instance) {
    return {
      ok: false,
      error: ref.host
        ? `${ref.host} is not a configured n8n instance. Add it to config/n8n.example.json,`
          + ` or pass --instance <${ids.join('|') || 'id'}> if that host is one of these.`
        : `pass --instance <${ids.join('|') || 'id'}> — a bare id does not say which n8n it is on`,
    };
  }
  if (!instances?.[instance]) {
    return { ok: false, error: `unknown instance "${instance}". Configured: ${ids.join(', ') || 'none'}` };
  }

  const entry = { id: ref.id, instance };
  if (name) entry.name = name;
  if (project) entry.project = project;
  if (description) entry.description = description;
  entry.monitoring = true;
  if (noReport) entry.reporting = false;

  if (every != null) {
    const mins = parseMinutes(every);
    if (mins == null || mins < 1) return { ok: false, error: `--every takes a duration like 60m, 6h or 1d (got "${every}")` };
    entry.expectedIntervalMin = mins;
  }
  if (staleAfter != null) {
    const mins = parseMinutes(staleAfter);
    if (mins == null || mins < 1) return { ok: false, error: `--stale-after takes a duration like 90m (got "${staleAfter}")` };
    entry.staleAfterMin = mins;
  }
  if (minItems != null) {
    const n = Number(minItems);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: `--min-items takes a whole number (got "${minItems}")` };
    entry.minimumItems = n;
  }
  if (dropPct != null) {
    const n = Number(dropPct);
    if (!Number.isFinite(n) || n <= 0 || n >= 100) return { ok: false, error: `--drop-pct takes a percentage between 1 and 99 (got "${dropPct}")` };
    entry.anomalyDropPct = n;
  }
  if (checkpoints.length) entry.checkpoints = checkpoints;

  // The URL is kept so the dashboard can link back to the editor even if the
  // instance's publicUrl later changes shape.
  if (ref.origin) entry.url = `${ref.origin}/workflow/${ref.id}`;

  return { ok: true, entry, dryRun };
}

/**
 * Every workflow the estate inventory says is switched on, as registry entries.
 *
 * The ingest already knows these: `kw-collect.sh` runs `n8n list:workflow` on
 * each box and `data/workflows.json` holds the result — real ids, real names,
 * which server, which group. Registering them by hand from that list is
 * transcription, and transcription of twenty ids is a typo waiting to happen.
 *
 * Template imports are skipped. There are roughly a hundred of them, nobody
 * built them, and monitoring them would bury the dozen that matter.
 *
 * Nothing is invented: no expected interval is guessed, because this file
 * cannot know whether a workflow is a nightly cron or a webhook, and a wrong
 * interval produces a stale alert every night for a workflow that is fine.
 *
 * @returns {{ entries: object[], skipped: Array<{id, name, why}> }}
 */
export function discoverFromInventory({ workflows, projects = {}, instances }) {
  const byServer = new Map();
  for (const inst of Object.values(instances)) {
    if (inst.server) byServer.set(inst.server, inst.id);
  }

  // Ownership, not hosting. The n8n platform project lists every workflow on
  // the box — all 138 of them — because it runs them, and taking that as
  // "project" would stamp the same value on every row and make the column
  // worthless. A DOCUMENTED project claiming a workflow is a person saying it
  // belongs to them, which is the thing worth recording.
  const owner = {};
  for (const [pid, project] of Object.entries(projects)) {
    if (project.origin !== 'documented') continue;
    for (const wid of project.workflows ?? []) owner[wid] = pid;
  }

  const entries = [];
  const skipped = [];

  for (const [id, wf] of Object.entries(workflows)) {
    if (!wf.active || wf.noise) continue;
    if (!WORKFLOW_ID_RE.test(id)) { skipped.push({ id, name: wf.name, why: 'not a usable workflow id' }); continue; }

    const instance = wf.server ? byServer.get(wf.server) : null;
    if (!instance) {
      skipped.push({
        id,
        name: wf.name,
        why: wf.server
          ? `no enabled n8n instance is declared for ${wf.server}`
          : 'the dump did not say which server it is on',
      });
      continue;
    }

    const entry = { id, instance, name: wf.name, monitoring: true };
    if (owner[id]) entry.project = owner[id];
    // The group the ingest already assigned is the best available description
    // of what the thing does, and it is better than an empty field.
    if (wf.group && wf.group !== 'Ungrouped') entry.description = `${wf.group} workflow, discovered from the n8n inventory.`;
    entries.push(entry);
  }

  return { entries, skipped };
}

/**
 * Write the entry, merging over any existing id.
 *
 * Defaults to config/n8n.json, the GIT-IGNORED override, and that is not a
 * detail. The tracked config/n8n.example.json is listed in pull.sh's
 * CODE_PATHS, so every collection pass runs `git checkout origin/main --
 * config` over it — three workflows registered on the box with --discover
 * were silently reverted by the next pull, and the only symptom was a report
 * covering thirteen workflows instead of sixteen. An untracked file cannot be
 * clobbered by git, and the registry merge already lets it win.
 *
 * `--tracked` writes to the example file instead, which is the right thing in
 * a repo checkout where the change is going to be committed and shipped.
 *
 * @returns {{ written: boolean, replaced: boolean, file: string }}
 */
export function saveEntry(entry, { file = abs('config', 'n8n.json') } = {}) {
  const current = readJson(file);
  const config = current.ok ? current.value : { instances: {}, workflows: [] };
  const list = config.workflows ?? [];
  const at = list.findIndex((w) => w.id === entry.id && w.instance === entry.instance);
  const replaced = at !== -1;
  if (replaced) list[at] = { ...list[at], ...entry };
  else list.push(entry);
  config.workflows = list;

  // Not serializeJson(): that sorts keys deep and would reflow this whole
  // hand-written file, _comment keys and all, into alphabetical order.
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { written: true, replaced, file };
}

async function main() {
  const argv = process.argv.slice(2);
  const registry = resolveRegistry();

  if (argv.includes('--help') || argv.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(argv.length === 0 ? 1 : 0);
  }

  if (argv.includes('--list')) {
    const inst = Object.values(registry.instances);
    process.stdout.write(`\n${inst.length} instance${inst.length === 1 ? '' : 's'}\n`);
    for (const i of inst) process.stdout.write(`  ${i.id.padEnd(12)} ${i.baseUrl}  key from $${i.apiKeyEnv}\n`);
    process.stdout.write(`\n${registry.workflows.length} monitored workflow${registry.workflows.length === 1 ? '' : 's'}\n`);
    for (const w of registry.workflows) {
      process.stdout.write(`  ${w.id.padEnd(18)} ${String(w.name ?? '—').slice(0, 40).padEnd(42)}`
        + `${w.instance}  ${w.expectedIntervalMin ? `every ${w.expectedIntervalMin}m` : 'no schedule'}\n`);
    }
    for (const e of registry.errors) process.stdout.write(`  ! ${e}\n`);
    process.exit(0);
  }

  if (argv.includes('--discover')) {
    const dry = argv.includes('--dry-run');
    const workflows = readJson(abs('data', 'workflows.json'));
    if (!workflows.ok) {
      process.stderr.write('✗ no data/workflows.json — ingest a dump first, then try again.\n');
      process.exitCode = 1;
      return;
    }
    const projects = readJson(abs('data', 'projects.json'));
    const { entries, skipped } = discoverFromInventory({
      workflows: workflows.value,
      projects: projects.ok ? projects.value : {},
      instances: registry.instances,
    });

    const already = new Set(registry.workflows.map((w) => `${w.instance}/${w.id}`));
    const fresh = entries.filter((e) => !already.has(`${e.instance}/${e.id}`));

    process.stdout.write(`\n${entries.length} active workflow${entries.length === 1 ? '' : 's'} in the inventory`
      + `, ${already.size} already registered\n\n`);
    for (const e of fresh) {
      process.stdout.write(`  + ${e.id.padEnd(22)} ${String(e.name).slice(0, 46).padEnd(48)}`
        + `${e.instance}${e.project ? `  ${e.project}` : ''}\n`);
    }
    for (const s of skipped) {
      process.stdout.write(`  ! ${String(s.id).padEnd(22)} ${String(s.name).slice(0, 46).padEnd(48)}${s.why}\n`);
    }

    if (!fresh.length) {
      process.stdout.write('\nNothing new to add.\n');
      return;
    }
    if (dry) {
      process.stdout.write('\n--dry-run: nothing written\n');
      return;
    }
    const target = argv.includes('--tracked') ? abs('config', 'n8n.example.json') : abs('config', 'n8n.json');
    for (const e of fresh) saveEntry(e, { file: target });
    process.stdout.write(`\nRegistered ${fresh.length} workflow${fresh.length === 1 ? '' : 's'} in config/n8n.example.json.\n`
      + '  No expected interval was set for any of them: this cannot know whether a workflow is a\n'
      + '  nightly cron or a webhook, and a wrong interval mails everybody about a workflow that is fine.\n'
      + '  Set one per workflow in the admin panel once you know its schedule.\n'
      + '  Collect them now:  npm run wf-sync\n');
    return;
  }

  const built = buildEntry(argv, { instances: registry.instances, dryRun: argv.includes('--dry-run') });
  if (!built.ok) {
    process.stderr.write(`✗ ${built.error}\n`);
    process.exit(2);
  }

  // Confirm the workflow exists before writing it down. A typo in an id is
  // otherwise invisible until the first collection pass reports nothing, and
  // "no executions" reads identically to "a workflow that never runs".
  const instance = registry.instances[built.entry.instance];
  let confirmed = null;
  try {
    const { fetchWorkflow } = await import('./client.js');
    confirmed = await fetchWorkflow(instance, built.entry.id);
  } catch (e) {
    process.stdout.write(`! could not confirm against ${instance.baseUrl}: ${e.message}\n`
      + '  Registering anyway — the next wf-sync will report it if the id is wrong.\n');
  }
  if (confirmed?.name && !built.entry.name) built.entry.name = confirmed.name;
  if (confirmed) {
    process.stdout.write(`✓ ${instance.id} knows ${built.entry.id}: ${confirmed.name}`
      + `${confirmed.active === false ? ' (currently switched off)' : ''}\n`);
  }

  if (built.dryRun) {
    process.stdout.write(`${JSON.stringify(built.entry, null, 2)}\n--dry-run: nothing written\n`);
    return;
  }

  const { replaced, file } = saveEntry(built.entry, argv.includes('--tracked')
    ? { file: abs('config', 'n8n.example.json') } : {});
  process.stdout.write(`${replaced ? 'updated' : 'registered'} ${built.entry.id} in config/n8n.example.json\n`
    + '  Collect it now:  npm run wf-sync\n');
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(ROOT, 'src', 'n8n', 'registry.js')) await main();
