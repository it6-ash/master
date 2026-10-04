import test from 'node:test';
import assert from 'node:assert/strict';

import { safeError } from '../src/n8n/client.js';

/* ------------------------------------------------------- startedAfter */

test('an n8n that does not know startedAfter is still collected from', async () => {
  // This took out five of thirteen workflows on the real box: `startedAfter`
  // is on the current API and genuinely useful, and is NOT on every version
  // in the field. The five that failed were the five with a cursor to send.
  //
  // Exercised through a stub `fetch` so the retry is proven rather than
  // reasoned about.
  const seen = [];
  const fakeFetch = async (url) => {
    const u = new URL(url);
    seen.push(u.searchParams.get('startedAfter'));
    if (u.searchParams.has('startedAfter')) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: "Unknown query parameter 'startedAfter'" }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ id: 2, status: 'success', startedAt: '2026-10-04T12:00:00Z' },
          { id: 1, status: 'success', startedAt: '2026-10-04T11:00:00Z' }],
        nextCursor: null,
      }),
    };
  };

  const realFetch = globalThis.fetch;
  process.env.KW_TEST_KEY = 'k';
  globalThis.fetch = fakeFetch;
  try {
    const { fetchExecutions } = await import('../src/n8n/client.js?startedafter');
    const instance = { id: 'probe-a', baseUrl: 'http://127.0.0.1:5678', apiKeyEnv: 'KW_TEST_KEY' };
    const got = await fetchExecutions(instance, 'aaaaaaaaaaaa', { startedAfter: '2026-10-04T10:00:00Z' });

    assert.equal(got.executions.length, 2, 'it recovered rather than failing the workflow');
    assert.equal(seen[0], '2026-10-04T10:00:00Z', 'tried the efficient form first');
    assert.equal(seen[1], null, 'then dropped it and retried');

    // And remembered, so the next workflow on the same instance does not
    // pay for the same 400 again.
    seen.length = 0;
    await fetchExecutions(instance, 'bbbbbbbbbbbb', { startedAfter: '2026-10-04T10:00:00Z' });
    assert.deepEqual(seen, [null], 'learned it once for this instance');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.KW_TEST_KEY;
  }
});

test('any other 400 is a real failure and is not swallowed', async () => {
  const realFetch = globalThis.fetch;
  process.env.KW_TEST_KEY = 'k';
  globalThis.fetch = async () => ({
    ok: false, status: 400, text: async () => JSON.stringify({ message: 'workflowId must be a string' }),
  });
  try {
    const { fetchExecutions } = await import('../src/n8n/client.js?other400');
    await assert.rejects(
      () => fetchExecutions({ id: 'probe-b', baseUrl: 'http://127.0.0.1:5678', apiKeyEnv: 'KW_TEST_KEY' }, 'aaaaaaaaaaaa', {}),
      /workflowId must be a string/,
    );
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.KW_TEST_KEY;
  }
});

/* ------------------------------------------------------------ secrets */

test('an API key never survives into a message that gets stored or printed', () => {
  const key = 'n8n_api_abcdef0123456789';
  assert.match(safeError(`HTTP 401 for key ${key}`, key), /\[REDACTED:n8n-api-key\]/);
  assert.doesNotMatch(safeError(`HTTP 401 for key ${key}`, key), /abcdef0123456789/);
  assert.match(safeError('X-N8N-API-KEY: someheadervalue'), /\[REDACTED:n8n-api-key\]/);
  assert.equal(safeError(undefined), 'unknown error');
});

test('a short key is not substituted, because that corrupts the message', () => {
  // Found by the startedAfter test: a one-character key turned
  // "Unknown query parameter" into "Un[REDACTED:n8n-api-key]nown query
  // parameter", hiding the exact sentence the operator needed. A real n8n key
  // is forty-odd characters; anything short enough to appear as a substring
  // of ordinary English is not a secret worth destroying a message for.
  assert.equal(safeError("Unknown query parameter 'startedAfter'", 'k'),
    "Unknown query parameter 'startedAfter'");
  assert.equal(safeError('workflowId must be a string', 'r'), 'workflowId must be a string');

  // A real one is still removed.
  const real = 'n8n_api_0123456789abcdef0123456789abcdef';
  assert.doesNotMatch(safeError(`rejected key ${real}`, real), /0123456789/);
});
