import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  sign, unsign, safeEqual, parseCookies, cookie, isAllowed, oauthConfig,
  startLogin, safeReturnTo, verifyIdToken, issueSession, sessionFrom, csrfOk,
  resetJwksCache, SESSION_COOKIE, STATE_COOKIE, SESSION_TTL_SEC,
} from '../src/auth.js';
import { parseEmails, entryFromForm } from '../src/admin.js';

const SECRET = 'a-test-session-secret-long-enough-to-be-real';
const NOW = Date.parse('2026-10-04T12:00:00.000Z');

/* ------------------------------------------------------------- signing */

test('a tampered payload fails, however plausible the edit', () => {
  const token = sign({ email: 'it6@kwgroup.in', exp: NOW / 1000 + 3600 }, SECRET);
  assert.equal(unsign(token, SECRET, { now: NOW }).email, 'it6@kwgroup.in');

  const [body, mac] = token.split('.');
  const forged = `${Buffer.from(JSON.stringify({ email: 'attacker@evil.com', exp: NOW / 1000 + 3600 })).toString('base64url')}.${mac}`;
  assert.equal(unsign(forged, SECRET, { now: NOW }), null, 'the payload is signed, so swapping it invalidates the MAC');
});

test('a different secret cannot read or mint a session', () => {
  const token = sign({ email: 'it6@kwgroup.in' }, SECRET);
  assert.equal(unsign(token, 'some-other-secret'), null);
});

test('an expired session is refused, not merely old', () => {
  const token = sign({ email: 'it6@kwgroup.in', exp: NOW / 1000 - 1 }, SECRET);
  assert.equal(unsign(token, SECRET, { now: NOW }), null);
  const fresh = sign({ email: 'it6@kwgroup.in', exp: NOW / 1000 + 1 }, SECRET);
  assert.ok(unsign(fresh, SECRET, { now: NOW }));
});

test('malformed input returns null rather than throwing into a 500', () => {
  for (const bad of ['', 'nodot', 'a.b.c.d', '.', 'x.y', undefined, null, '!!!.???']) {
    assert.equal(unsign(bad, SECRET), null, String(bad));
  }
});

test('safeEqual is length-safe and value-correct', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false, 'different lengths must not throw');
  assert.equal(safeEqual('', ''), true);
});

/* ------------------------------------------------------------- cookies */

test('cookies parse, including values that contain an equals sign', () => {
  const got = parseCookies('kw_estate_session=abc.def; other=1; padded =  2  ');
  assert.equal(got.kw_estate_session, 'abc.def');
  assert.equal(got.other, '1');
  assert.equal(parseCookies(undefined).anything, undefined);
  assert.equal(parseCookies('novalue').novalue, undefined);
});

test('the session cookie is HttpOnly, SameSite=Lax, and Secure only over https', () => {
  const https = cookie(SESSION_COOKIE, 'v', { secure: true });
  assert.match(https, /HttpOnly/);
  assert.match(https, /SameSite=Lax/);
  assert.match(https, /Secure/);
  // Secure on a plain-http localhost run silently drops the cookie and the
  // operator sees an endless redirect loop with nothing explaining it.
  assert.doesNotMatch(cookie(SESSION_COOKIE, 'v', { secure: false }), /Secure/);
  assert.match(cookie(SESSION_COOKIE, '', { clear: true }), /Max-Age=0/);
});

/* ----------------------------------------------------------- allowlist */

test('an empty allowlist denies everyone', () => {
  // A config that failed to load must never be the thing that opens the door.
  assert.equal(isAllowed('it6@kwgroup.in', {}), false);
  assert.equal(isAllowed('it6@kwgroup.in', { allowedEmails: [] }), false);
  assert.equal(isAllowed('it6@kwgroup.in', undefined), false);
});

test('the allowlist matches on the address, case and whitespace insensitively', () => {
  const admin = { allowedEmails: ['IT6@kwgroup.in', ' mdo60@kwgroup.in '] };
  assert.equal(isAllowed('it6@kwgroup.in', admin), true);
  assert.equal(isAllowed('IT6@KWGROUP.IN', admin), true);
  assert.equal(isAllowed('mdo60@kwgroup.in', admin), true);
  assert.equal(isAllowed('sm3@kwgroup.in', admin), false);
  assert.equal(isAllowed('', admin), false);
  assert.equal(isAllowed('not-an-email', admin), false);
  assert.equal(isAllowed(null, admin), false);
});

test('a domain allowance reads the part after the LAST @', () => {
  const admin = { allowedEmails: [], allowedDomain: 'kwgroup.in' };
  assert.equal(isAllowed('anyone@kwgroup.in', admin), true);
  assert.equal(isAllowed('anyone@evil.com', admin), false);
  // The classic near-miss. Google would not issue it, but a substring check
  // would have let it through.
  assert.equal(isAllowed('attacker@evil.com', { allowedEmails: [], allowedDomain: 'evil.com.kwgroup.in' }), false);
  assert.equal(isAllowed('a@sub.kwgroup.in', admin), false, 'a subdomain is a different domain');
  assert.equal(isAllowed('a@kwgroup.in', { allowedEmails: [], allowedDomain: '@kwgroup.in' }), true, 'a leading @ is tolerated');
});

/* -------------------------------------------------------- open redirect */

test('returnTo can only ever be a path on this site', () => {
  assert.equal(safeReturnTo('/admin'), '/admin');
  assert.equal(safeReturnTo('/admin?ok=1'), '/admin?ok=1');
  // Echoed into a Location header, each of these turns the login into an open
  // redirect that borrows Estate's hostname for a phishing page.
  assert.equal(safeReturnTo('https://evil.example'), '/');
  assert.equal(safeReturnTo('//evil.example'), '/');
  assert.equal(safeReturnTo('/\\evil.example'), '/');
  assert.equal(safeReturnTo('/admin\r\nSet-Cookie: x=1'), '/', 'header injection');
  assert.equal(safeReturnTo(undefined), '/');
});

/* ------------------------------------------------------------- OAuth */

const CONFIG = {
  clientId: 'test-client.apps.googleusercontent.com',
  clientSecret: 'secret',
  sessionSecret: SECRET,
  baseUrl: 'https://estate.leadq.co.in',
  missing: [],
  redirectUri: 'https://estate.leadq.co.in/auth/callback',
  secure: true,
};

test('oauthConfig names exactly what is missing rather than failing blankly', () => {
  const got = oauthConfig({ ADMIN_BASE_URL: 'https://estate.leadq.co.in' });
  assert.deepEqual(got.missing, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET']);
  assert.equal(got.redirectUri, 'https://estate.leadq.co.in/auth/callback');
  assert.equal(got.secure, true);

  const local = oauthConfig({
    GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', SESSION_SECRET: 'c',
    ADMIN_BASE_URL: 'http://localhost:4179/',
  });
  assert.deepEqual(local.missing, []);
  assert.equal(local.secure, false, 'no Secure flag on a plain-http local run');
  assert.equal(local.redirectUri, 'http://localhost:4179/auth/callback', 'the trailing slash is not doubled');
});

test('the login redirect carries a signed state bound to a single-use cookie', () => {
  const { url, stateCookie } = startLogin(CONFIG, { returnTo: '/admin', nonce: 'fixed-nonce', now: NOW });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(parsed.searchParams.get('client_id'), CONFIG.clientId);
  assert.equal(parsed.searchParams.get('redirect_uri'), CONFIG.redirectUri);
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.match(parsed.searchParams.get('scope'), /openid/);

  const state = unsign(parsed.searchParams.get('state'), SECRET, { now: NOW });
  assert.equal(state.n, 'fixed-nonce', 'the nonce in the state must match the cookie on the way back');
  assert.equal(state.r, '/admin');
  assert.match(stateCookie, new RegExp(`^${STATE_COOKIE}=fixed-nonce`));
  assert.match(stateCookie, /HttpOnly/);
});

test('a hostile returnTo is neutralised before it reaches the state', () => {
  const { url } = startLogin(CONFIG, { returnTo: 'https://evil.example', now: NOW });
  const state = unsign(new URL(url).searchParams.get('state'), SECRET, { now: NOW });
  assert.equal(state.r, '/');
});

/* ------------------------------------------------------ ID token checks */

/** A self-signed stand-in for a Google ID token, so the verifier can be tested. */
function makeIdToken(claims, { kid = 'test-kid', alg = 'RS256', key } = {}) {
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const data = `${header}.${body}`;
  if (alg === 'none') return `${data}.`;
  const sig = crypto.createSign('RSA-SHA256').update(data).sign(key.privateKey).toString('base64url');
  return `${data}.${sig}`;
}

const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...keyPair.publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
const KEYS = [JWK];

const goodClaims = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CONFIG.clientId,
  exp: Math.floor(NOW / 1000) + 3600,
  email: 'it6@kwgroup.in',
  email_verified: true,
  name: 'IT Six',
  ...over,
});

test('a properly signed Google ID token verifies and yields the address', async () => {
  const token = makeIdToken(goodClaims(), { key: keyPair });
  const got = await verifyIdToken(token, CONFIG, { now: NOW, keys: KEYS });
  assert.equal(got.ok, true, got.error);
  assert.equal(got.email, 'it6@kwgroup.in');
  assert.equal(got.name, 'IT Six');
});

test('the signature is checked BEFORE anything inside the token is believed', async () => {
  // The whole bug class: a decoded-but-unverified JWT is attacker-controlled
  // JSON, and treating its `email` as an identity is a complete auth bypass.
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const token = makeIdToken(goodClaims({ email: 'attacker@evil.com' }), { key: other });
  const got = await verifyIdToken(token, CONFIG, { now: NOW, keys: KEYS });
  assert.equal(got.ok, false);
  assert.match(got.error, /signature does not check out/);
});

test('alg:none and a swapped algorithm are refused, not negotiated', async () => {
  const none = await verifyIdToken(makeIdToken(goodClaims(), { alg: 'none' }), CONFIG, { now: NOW, keys: KEYS });
  assert.equal(none.ok, false);
  assert.match(none.error, /unexpected signing algorithm "none"/);

  const hs = await verifyIdToken(makeIdToken(goodClaims(), { alg: 'HS256', key: keyPair }), CONFIG, { now: NOW, keys: KEYS });
  assert.equal(hs.ok, false);
  assert.match(hs.error, /unexpected signing algorithm "HS256"/);
});

test('issuer, audience and expiry are all enforced', async () => {
  const cases = [
    [goodClaims({ iss: 'https://evil.example' }), /unexpected issuer/],
    [goodClaims({ aud: 'someone-elses-client.apps.googleusercontent.com' }), /different OAuth client/],
    [goodClaims({ exp: Math.floor(NOW / 1000) - 10 }), /has expired/],
  ];
  for (const [claims, re] of cases) {
    const got = await verifyIdToken(makeIdToken(claims, { key: keyPair }), CONFIG, { now: NOW, keys: KEYS });
    assert.equal(got.ok, false, JSON.stringify(claims));
    assert.match(got.error, re);
  }
});

test('an unverified Google address is refused', async () => {
  // Otherwise somebody can claim an address on the allowlist that is not
  // theirs, just by typing it into a Google account.
  const token = makeIdToken(goodClaims({ email_verified: false }), { key: keyPair });
  const got = await verifyIdToken(token, CONFIG, { now: NOW, keys: KEYS });
  assert.equal(got.ok, false);
  assert.match(got.error, /has not verified its email address/);
});

test('a token signed with a key Google does not publish is refused', async () => {
  const token = makeIdToken(goodClaims(), { key: keyPair, kid: 'unknown-kid' });
  resetJwksCache(KEYS);
  const got = await verifyIdToken(token, CONFIG, { now: NOW, keys: KEYS });
  assert.equal(got.ok, false);
  assert.match(got.error, /key Google does not publish/);
  resetJwksCache();
});

test('garbage in place of a token returns an error, never a throw', async () => {
  for (const bad of ['', 'x', 'a.b', 'a.b.c', undefined]) {
    const got = await verifyIdToken(bad, CONFIG, { now: NOW, keys: KEYS });
    assert.equal(got.ok, false, String(bad));
  }
});

/* ------------------------------------------------------------- session */

test('a session carries its own CSRF token and an expiry', () => {
  const issued = issueSession('it6@kwgroup.in', CONFIG, { now: NOW });
  assert.equal(issued.payload.email, 'it6@kwgroup.in');
  assert.equal(issued.payload.exp - issued.payload.iat, SESSION_TTL_SEC);
  assert.match(issued.payload.csrf, /^[0-9a-f]{32}$/);
  assert.match(issued.setCookie, /HttpOnly/);
});

test('the allowlist is re-checked on every request, not only at login', () => {
  // Removing somebody has to take effect now, not in eight hours when their
  // cookie happens to expire.
  const issued = issueSession('it6@kwgroup.in', CONFIG, { now: NOW });
  const req = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(issued.token)}` } };

  assert.equal(sessionFrom(req, CONFIG, { allowedEmails: ['it6@kwgroup.in'] }, { now: NOW })?.email, 'it6@kwgroup.in');
  assert.equal(sessionFrom(req, CONFIG, { allowedEmails: ['someone-else@kwgroup.in'] }, { now: NOW }), null);
  assert.equal(sessionFrom(req, CONFIG, { allowedEmails: [] }, { now: NOW }), null);
});

test('no cookie, a junk cookie and an expired cookie are all simply "not signed in"', () => {
  const admin = { allowedEmails: ['it6@kwgroup.in'] };
  assert.equal(sessionFrom({ headers: {} }, CONFIG, admin), null);
  assert.equal(sessionFrom({ headers: { cookie: `${SESSION_COOKIE}=garbage` } }, CONFIG, admin), null);
  const stale = issueSession('it6@kwgroup.in', CONFIG, { now: NOW - (SESSION_TTL_SEC + 10) * 1000 });
  assert.equal(sessionFrom(
    { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(stale.token)}` } },
    CONFIG, admin, { now: NOW },
  ), null);
});

test('CSRF requires the session token exactly', () => {
  const issued = issueSession('it6@kwgroup.in', CONFIG, { now: NOW });
  assert.equal(csrfOk(issued.payload, issued.payload.csrf), true);
  assert.equal(csrfOk(issued.payload, 'nope'), false);
  assert.equal(csrfOk(issued.payload, ''), false);
  assert.equal(csrfOk(issued.payload, undefined), false);
  assert.equal(csrfOk(null, 'anything'), false);
  assert.equal(csrfOk({}, ''), false, 'a session with no csrf token can never pass');
});

/* --------------------------------------------------------- admin writes */

test('recipient lists parse off any separator and name what was invalid', () => {
  const got = parseEmails('it6@kwgroup.in\nmdo60@kwgroup.in, sm3@kwgroup.in; IT6@KWGROUP.IN\nnot-an-email');
  assert.deepEqual(got.emails, ['it6@kwgroup.in', 'mdo60@kwgroup.in', 'sm3@kwgroup.in']);
  assert.deepEqual(got.invalid, ['not-an-email'], 'named, not silently dropped');
  assert.deepEqual(parseEmails('').emails, []);
  assert.deepEqual(parseEmails(undefined).emails, []);
});

const INSTANCES = {
  'n8n-main': { id: 'n8n-main', baseUrl: 'http://127.0.0.1:5678', hosts: ['127.0.0.1', 'n8n.srv1340120.hstgr.cloud'] },
};

test('the panel builds a registry entry from a pasted URL', () => {
  const got = entryFromForm({
    url: 'https://n8n.srv1340120.hstgr.cloud/workflow/S3Yx1gWQAJYy7mYM',
    name: 'Lead Qualification',
    project: 'yamini',
    expectedIntervalMin: '60',
    minimumItems: '1',
    checkpoints: 'Fetch from Cratio\nMeta CAPI',
    monitoring: 'on',
  }, { instances: INSTANCES });

  assert.equal(got.ok, true, got.error);
  assert.equal(got.entry.id, 'S3Yx1gWQAJYy7mYM');
  assert.equal(got.entry.instance, 'n8n-main');
  assert.equal(got.entry.expectedIntervalMin, 60);
  assert.deepEqual(got.entry.checkpoints, ['Fetch from Cratio', 'Meta CAPI'],
    'checkpoints are n8n node names and are only trimmed, never case-folded');
});

test('every numeric field is bounded, so a typo cannot poison the config', () => {
  // `expectedIntervalMin: 0` would make the workflow permanently stale and
  // mail everybody about it every six hours.
  const got = entryFromForm({
    url: 'S3Yx1gWQAJYy7mYM', instance: 'n8n-main',
    expectedIntervalMin: '0', anomalyDropPct: '500', minimumItems: '-5', consecutiveFailures: '0',
  }, { instances: INSTANCES });
  assert.equal(got.ok, true);
  assert.equal(got.entry.expectedIntervalMin, 1);
  assert.equal(got.entry.anomalyDropPct, 99);
  assert.equal(got.entry.minimumItems, 0);
  assert.equal(got.entry.consecutiveFailures, 1);
});

test('a non-numeric threshold is left unset rather than written as NaN', () => {
  const got = entryFromForm({
    url: 'S3Yx1gWQAJYy7mYM', instance: 'n8n-main', expectedIntervalMin: 'soon', minimumItems: '',
  }, { instances: INSTANCES });
  assert.equal(got.ok, true);
  assert.equal('expectedIntervalMin' in got.entry, false);
  assert.equal('minimumItems' in got.entry, false);
});

test('the panel refuses an instance it does not know, and a bad URL', () => {
  const unknown = entryFromForm({ url: 'S3Yx1gWQAJYy7mYM', instance: 'made-up' }, { instances: INSTANCES });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /not a configured n8n instance/);

  const foreign = entryFromForm({ url: 'https://someone-elses-n8n.com/workflow/S3Yx1gWQAJYy7mYM' }, { instances: INSTANCES });
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /not one of the configured hosts/);

  const nonsense = entryFromForm({ url: 'https://n8n.srv1340120.hstgr.cloud/home/workflows' }, { instances: INSTANCES });
  assert.equal(nonsense.ok, false);
});

test('free text is length-capped before it is written to config', () => {
  const got = entryFromForm({
    url: 'S3Yx1gWQAJYy7mYM', instance: 'n8n-main',
    name: 'x'.repeat(500), description: 'y'.repeat(900),
    checkpoints: Array.from({ length: 60 }, (_, i) => `Node ${i}`).join('\n'),
  }, { instances: INSTANCES });
  assert.equal(got.entry.name.length, 120);
  assert.equal(got.entry.description.length, 400);
  assert.equal(got.entry.checkpoints.length, 24);
});
