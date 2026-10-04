/**
 * The only place in this repo that talks to an n8n API.
 *
 * Endpoints used, all from the n8n public API (v1). Nothing here is invented:
 *
 *   GET /api/v1/workflows/{id}
 *   GET /api/v1/executions?workflowId=&startedAfter=&limit=&cursor=
 *   GET /api/v1/executions/{id}?includeData=true
 *
 * Auth is the `X-N8N-API-KEY` header. The key is read from the environment
 * variable the instance names and is never written anywhere — not to data/, not
 * to the page, not into an error message (see `safeError`).
 *
 * Two hard rules:
 *
 *   1. The base URL comes from the resolved registry and nowhere else. A
 *      workflow cannot cause a request to a host that is not in the instance
 *      allowlist, which is what stops a pasted URL from becoming an SSRF.
 *   2. Every call is bounded — AbortSignal.timeout on the request, a page cap
 *      on pagination. A hung n8n must not hold the 6-hourly timer.
 */

const TIMEOUT_MS = 30000;
/** The documented maximum for the executions endpoint. */
export const PAGE_LIMIT = 250;
/** 250 x 40 = 10,000 executions in one pass, which is n8n's own prune ceiling. */
const MAX_PAGES = 40;

import fs from 'node:fs';

/**
 * Strip anything key-shaped out of a message before it is stored or printed.
 *
 * An n8n 401 body can echo the header back. This file is the one place a key
 * exists in memory, so it is the one place that has to care.
 */
export function safeError(message, key) {
  let text = String(message ?? 'unknown error').slice(0, 300);
  if (key) text = text.split(key).join('[REDACTED:n8n-api-key]');
  return text.replace(/X-N8N-API-KEY\s*:\s*\S+/gi, 'X-N8N-API-KEY: [REDACTED:n8n-api-key]');
}

export function apiKeyFor(instance) {
  const name = instance?.apiKeyEnv;
  if (!name) throw new Error(`instance "${instance?.id}" does not name an apiKeyEnv`);
  const key = process.env[name];
  if (key) return key;

  // The variable being absent and the FILE being absent are different
  // problems with different fixes, and saying "create an API key" to somebody
  // who has already created one and put it in the right file is how an
  // afternoon goes. /etc/kw-estate.env is read by systemd's EnvironmentFile
  // and by the npm scripts — never by a bare `node src/...`, which is exactly
  // how this gets hit.
  let envFileHasIt = false;
  try {
    envFileHasIt = new RegExp(`^${name}=.+`, 'm').test(fs.readFileSync('/etc/kw-estate.env', 'utf8'));
  } catch { /* no such file, or not readable: the first case below applies */ }

  throw new Error(envFileHasIt
    ? `$${name} is set in /etc/kw-estate.env but not in this shell — that file is read by systemd and by the`
      + ' npm scripts, not by a bare `node`. Use `npm run wf-sync`, or: set -a; . /etc/kw-estate.env; set +a'
    : `$${name} is not set, so ${instance.id} cannot be reached. Create an API key in n8n under`
      + ' Settings -> n8n API, put it in /etc/kw-estate.env, and run `npm run wf-sync`.');
}

/**
 * One request. Returns the parsed body, or throws with a message that names
 * the status and says what it means in n8n's terms.
 */
async function request(instance, pathname, params = {}) {
  const key = apiKeyFor(instance);
  const url = new URL(`${instance.baseUrl}/api/v1${pathname}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: { 'X-N8N-API-KEY': key, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : (e.cause?.code ?? e.message);
    throw new Error(safeError(`${instance.baseUrl} unreachable: ${why}`, key));
  }

  const text = await res.text();
  if (!res.ok) {
    const hint = {
      401: 'the API key was rejected — check the value of $' + instance.apiKeyEnv,
      403: 'the key is valid but not allowed to read this',
      404: 'no such workflow or execution on this instance',
    }[res.status] ?? (res.status === 503 ? 'n8n is up but not ready' : null);
    throw new Error(safeError(`HTTP ${res.status}${hint ? ` — ${hint}` : ''}: ${text.slice(0, 160)}`, key));
  }

  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // The public API disabled (N8N_PUBLIC_API_DISABLED=true) serves the editor
    // SPA at this path instead of 404ing, so the symptom is HTML where JSON
    // was expected. Say that, rather than "Unexpected token <".
    throw new Error(/^\s*</.test(text)
      ? `${instance.baseUrl} answered HTML, not JSON — the n8n public API looks disabled on this instance`
      : safeError(`unparseable reply from ${instance.baseUrl}`, key));
  }
  return { body, ms: Date.now() - started };
}

export async function fetchWorkflow(instance, workflowId) {
  const { body } = await request(instance, `/workflows/${encodeURIComponent(workflowId)}`);
  return body;
}

/**
 * Executions for one workflow, newest first, stopping at `startedAfter`.
 *
 * `startedAfter` is the incremental cursor and is served by n8n itself, so a
 * pass transfers only what is new rather than the whole history. `stopAtId`
 * is a second brake for the case where the cursor is coarse: n8n returns
 * newest-first, so the moment a known id appears everything behind it is
 * already stored.
 *
 * @returns {{ executions: object[], pages: number, ms: number, truncated: boolean }}
 */
export async function fetchExecutions(instance, workflowId, {
  startedAfter = null, stopAtId = null, limit = PAGE_LIMIT, maxPages = MAX_PAGES,
} = {}) {
  const executions = [];
  let cursor = null;
  let pages = 0;
  let ms = 0;
  let truncated = false;

  for (;;) {
    const { body, ms: took } = await request(instance, '/executions', {
      workflowId,
      limit,
      cursor,
      startedAfter,
      // Deliberately false. includeData on a LIST response returns every node's
      // input and output for every execution in the page — megabytes per page,
      // and n8n may withhold it anyway past its size limit. Node-level counts
      // are fetched per execution, budgeted, by fetchExecutionDetail.
      includeData: false,
    });
    ms += took;
    pages += 1;

    const page = Array.isArray(body?.data) ? body.data : [];
    for (const execution of page) {
      if (stopAtId != null && String(execution.id) === String(stopAtId)) {
        return { executions, pages, ms, truncated };
      }
      executions.push(execution);
    }

    cursor = body?.nextCursor ?? null;
    if (!cursor || page.length === 0) break;
    if (pages >= maxPages) { truncated = true; break; }
  }

  return { executions, pages, ms, truncated };
}

/**
 * One execution with its node data, which is the only route to item counts.
 *
 * Returns null rather than throwing on 404: n8n prunes executions on its own
 * schedule (EXECUTIONS_DATA_MAX_AGE, 14 days by default), so an id that was
 * listed one pass and is gone the next is normal operation, not a fault.
 */
export async function fetchExecutionDetail(instance, executionId) {
  try {
    const { body, ms } = await request(instance, `/executions/${encodeURIComponent(executionId)}`, {
      includeData: true,
    });
    return { execution: body, ms };
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return null;
    throw e;
  }
}

/** Is this instance answering at all? Used by the collector's own health panel. */
export async function ping(instance) {
  const started = Date.now();
  try {
    await request(instance, '/executions', { limit: 1 });
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e.message };
  }
}
