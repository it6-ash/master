/**
 * Execution telemetry WITHOUT the n8n public API, by reading n8n's own
 * database over SSH.
 *
 * The API was the original source and is no longer available here. This file
 * is the replacement, and it exposes exactly the same three functions as
 * client.js — fetchExecutions, fetchExecutionDetail, ping — so the collector
 * picks a driver and nothing else in the module changes.
 *
 * It is also a better fit for this estate than the API ever was: every other
 * fact on the dashboard already arrives as SSH plus a read-only shell command
 * (see kw-collect.sh), and this is the same idiom. No API key to create, store
 * or rotate, no public port, no n8n configuration at all.
 *
 * HOW IT READS A LIVE DATABASE SAFELY
 *
 *   sqlite3 -readonly. n8n runs its SQLite in WAL mode, where readers never
 *   block writers and writers never block readers, so a SELECT against the
 *   live file is safe and sees a consistent snapshot. Nothing here opens the
 *   file for writing, and -readonly makes that a guarantee rather than an
 *   intention.
 *
 *   The file is read from the HOST, at the path docker reports for the
 *   container's volume. Running sqlite3 inside the n8n container would be
 *   neater but the image does not ship it, and installing anything into a
 *   running production container to monitor it is the wrong trade.
 *
 * WHAT IT COSTS THE BOX
 *
 *   One SSH connection and two SELECTs per workflow per pass, against an
 *   indexed column, on a database n8n is already serving. The metadata query
 *   never reads the payload column; the payload is fetched only for the
 *   budgeted subset that needs item counts.
 */

import { spawn } from 'node:child_process';

const SSH_TIMEOUT_MS = 60000;
/** n8n's default SQLite location inside the container. */
export const DEFAULT_DB = '/home/node/.n8n/database.sqlite';

/* --------------------------------------------------------------- runner */

function run(command, argv, { timeout = SSH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

const sshArgs = (instance) => [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=15',
  ...(instance.sshKey ? ['-i', instance.sshKey] : []),
  ...(instance.sshPort ? ['-p', String(instance.sshPort)] : []),
];

/**
 * Run a shell command on the instance's box.
 *
 * `host` of 127.0.0.1 or localhost means THIS machine, and is run directly.
 * srv1340120 hosts both the dashboard and the main n8n, so the common case
 * needs no SSH at all — and going out through sshd to reach yourself means the
 * box has to trust its own key, which is a second way to fail at something
 * that needs no network. sync.js makes the same call for the same reason.
 */
async function onHost(instance, script) {
  const host = instance.sshHost ?? '127.0.0.1';
  const local = ['127.0.0.1', '::1', 'localhost'].includes(host);
  // `bash -c`, never `bash -lc`. A login shell re-reads /etc/profile and the
  // root profile, which REPLACES the PATH this process was given — so under
  // systemd the command would run with a different PATH than the unit
  // defines, and the failure mode is "sqlite3: not found" on a box where
  // sqlite3 is installed.
  return local
    ? run('bash', ['-c', script])
    : run('ssh', [...sshArgs(instance), `${instance.sshUser ?? 'root'}@${host}`, script]);
}

/* ------------------------------------------------------------ db path */

const pathCache = new Map();

/**
 * Where the container's n8n directory actually lives on the host.
 *
 * Asked of docker rather than assumed: a named volume lands under
 * /var/lib/docker/volumes/<name>/_data, a bind mount lands wherever the
 * compose file says, and hardcoding either is a path that works on one box.
 */
export async function resolveDbPath(instance) {
  if (instance.dbHostPath) return { ok: true, path: instance.dbHostPath };
  const key = `${instance.id}:${instance.container}`;
  if (pathCache.has(key)) return pathCache.get(key);

  if (!instance.container) {
    return { ok: false, error: `instance "${instance.id}" names no container, and no dbHostPath` };
  }

  const dir = (instance.dbPath ?? DEFAULT_DB).replace(/\/[^/]+$/, '');
  const file = (instance.dbPath ?? DEFAULT_DB).split('/').pop();
  const script = `docker inspect -f '{{range .Mounts}}{{if eq .Destination "${dir}"}}{{.Source}}{{end}}{{end}}' `
    + `${instance.container} 2>/dev/null`;

  const got = await onHost(instance, script);
  const source = got.stdout.trim().split('\n').filter(Boolean).pop();
  if (got.code !== 0 || !source) {
    const result = {
      ok: false,
      error: `could not find where ${instance.container} keeps ${dir}.`
        + ` Is the container running? ${(got.stderr || '').trim().slice(0, 120)}`,
    };
    return result; // not cached: a stopped container is worth re-asking about
  }

  const result = { ok: true, path: `${source.replace(/\/+$/, '')}/${file}` };
  pathCache.set(key, result);
  return result;
}

/* ---------------------------------------------------------------- query */

/**
 * One read-only SELECT, answered as JSON.
 *
 * The SQL is built here and never from caller input: the only variable that
 * reaches it is a workflow id, which the registry has already matched against
 * ^[A-Za-z0-9_-]{8,36}$, and a timestamp this module formats itself. There is
 * no path from a pasted URL to this string.
 */
async function query(instance, sql) {
  const resolved = await resolveDbPath(instance);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  // Single-quoted heredoc: the SQL reaches sqlite3 exactly as written, with no
  // shell expansion of $ or backticks on the way.
  const script = `sqlite3 -readonly -json ${JSON.stringify(resolved.path)} <<'KWSQL'\n${sql}\nKWSQL`;
  const got = await onHost(instance, script);

  if (got.code !== 0) {
    const why = (got.stderr || got.stdout || '').trim().slice(0, 200);
    if (/sqlite3: (command )?not found/i.test(why)) {
      return {
        ok: false,
        error: 'sqlite3 is not installed on that box. apt install -y sqlite3 — it is a read-only client,'
          + ' it does not touch the database n8n is using except to read it.',
      };
    }
    if (/unable to open database|no such file/i.test(why)) {
      return { ok: false, error: `cannot open ${resolved.path}: ${why}` };
    }
    return { ok: false, error: why || 'sqlite3 failed with no message' };
  }

  const text = got.stdout.trim();
  if (!text) return { ok: true, rows: [] };
  try {
    return { ok: true, rows: JSON.parse(text) };
  } catch {
    return { ok: false, error: `unreadable sqlite3 output: ${text.slice(0, 160)}` };
  }
}

/** ISO in, a form SQLite's datetime() compares correctly out. */
const sqlTime = (iso) => String(iso).replace('T', ' ').replace('Z', '').slice(0, 23);

/**
 * n8n stores these as DATETIME, which SQLite keeps as text in a couple of
 * shapes depending on the driver version. Normalised on the way out so every
 * row this module returns looks like the API's.
 */
const ISO = (column) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) AS ${column.split('.').pop()}`;

/* ------------------------------------------------------------ the driver */

/**
 * Executions for one workflow, newest first, stopping at `startedAfter`.
 *
 * Metadata only — the payload column is not read here. `length(d.data)` is
 * taken instead, which is the byte size of the stored execution data and is
 * the honest analogue of the API's jsonSizeBytes.
 */
export async function fetchExecutions(instance, workflowId, {
  startedAfter = null, stopAtId = null, limit = 250, maxPages = 40,
} = {}) {
  const started = Date.now();
  const cap = Math.min(limit * maxPages, 10000);

  const sql = `SELECT
      e.id, e.workflowId, e.status, e.finished, e.mode, e.retryOf, e.retrySuccessId,
      ${ISO('e.startedAt')}, ${ISO('e.stoppedAt')}, ${ISO('e.createdAt')},
      length(d.data) AS jsonSizeBytes
    FROM execution_entity e
    LEFT JOIN execution_data d ON d.executionId = e.id
    WHERE e.workflowId = '${workflowId}'
      ${startedAfter ? `AND datetime(e.startedAt) > datetime('${sqlTime(startedAfter)}')` : ''}
    ORDER BY e.startedAt DESC
    LIMIT ${cap};`;

  const got = await query(instance, sql);
  if (!got.ok) throw new Error(got.error);

  const executions = [];
  for (const row of got.rows) {
    if (stopAtId != null && String(row.id) === String(stopAtId)) break;
    executions.push({
      ...row,
      // SQLite has no booleans. 1/0 would make `finished === true` false, and
      // statusOf() would then call every success a failure.
      finished: row.finished === 1 || row.finished === true,
      retryOf: row.retryOf ?? null,
    });
  }

  return {
    executions,
    pages: 1,
    ms: Date.now() - started,
    truncated: got.rows.length >= cap,
  };
}

/**
 * One execution with its payload.
 *
 * `data` comes out flatted-encoded, exactly as n8n wrote it; volume.js
 * unflattens it. Returns null for an id that is gone, which is normal: n8n
 * prunes its own executions on a schedule and an id listed one pass can be
 * absent the next.
 */
export async function fetchExecutionDetail(instance, executionId) {
  const started = Date.now();
  const id = Number(executionId);
  if (!Number.isInteger(id)) return null;

  const got = await query(instance, `SELECT
      e.id, e.workflowId, e.status, e.finished, e.mode, e.retryOf,
      ${ISO('e.startedAt')}, ${ISO('e.stoppedAt')},
      length(d.data) AS jsonSizeBytes, d.data
    FROM execution_entity e
    LEFT JOIN execution_data d ON d.executionId = e.id
    WHERE e.id = ${id};`);

  if (!got.ok) throw new Error(got.error);
  const row = got.rows[0];
  if (!row) return null;

  return {
    execution: {
      ...row,
      finished: row.finished === 1 || row.finished === true,
      // The column is TEXT holding a flatted array. Parsed here so volume.js
      // meets the same shape it would from the API.
      data: (() => {
        if (typeof row.data !== 'string' || !row.data) return undefined;
        try { return JSON.parse(row.data); } catch { return undefined; }
      })(),
    },
    ms: Date.now() - started,
  };
}

/**
 * Many executions with their payloads, in ONE query.
 *
 * This exists because the obvious implementation is unusably slow. Asking for
 * detail one execution at a time means one `sqlite3` process per execution —
 * on the first backfill that was ~2,000 process spawns and 8 to 17 seconds per
 * workflow, which looks exactly like a hang. The API driver pays a round trip
 * per execution and cannot avoid it; a database can answer in bulk, and not
 * doing so was throwing away the main advantage of reading one.
 *
 * Chunked rather than unbounded: the payload column is the biggest thing in
 * the database, and `WHERE id IN (...)` over a few hundred of them would move
 * tens of megabytes through a shell pipe in one go.
 */
export const DETAIL_CHUNK = 25;

export async function fetchExecutionDetails(instance, executionIds) {
  const ids = executionIds.map(Number).filter(Number.isInteger);
  if (!ids.length) return { executions: [], ms: 0 };

  const started = Date.now();
  const out = [];

  for (let i = 0; i < ids.length; i += DETAIL_CHUNK) {
    const chunk = ids.slice(i, i + DETAIL_CHUNK);
    const got = await query(instance, `SELECT
        e.id, e.workflowId, e.status, e.finished, e.mode, e.retryOf,
        ${ISO('e.startedAt')}, ${ISO('e.stoppedAt')},
        length(d.data) AS jsonSizeBytes, d.data
      FROM execution_entity e
      LEFT JOIN execution_data d ON d.executionId = e.id
      WHERE e.id IN (${chunk.join(',')});`);

    if (!got.ok) throw new Error(got.error);
    for (const row of got.rows) {
      out.push({
        ...row,
        finished: row.finished === 1 || row.finished === true,
        data: (() => {
          if (typeof row.data !== 'string' || !row.data) return undefined;
          try { return JSON.parse(row.data); } catch { return undefined; }
        })(),
      });
    }
  }

  return { executions: out, ms: Date.now() - started };
}

/** Is the database reachable and shaped the way this driver expects? */
export async function ping(instance) {
  const started = Date.now();
  const got = await query(instance, "SELECT count(*) AS n FROM execution_entity WHERE 1=0;");
  if (!got.ok) return { ok: false, ms: Date.now() - started, error: got.error };
  return { ok: true, ms: Date.now() - started };
}

/** Named so the collector's error messages can say which driver spoke. */
export const DRIVER = 'sqlite';
