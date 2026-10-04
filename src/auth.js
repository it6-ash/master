/**
 * Google sign-in with an email allowlist, and the session that follows it.
 *
 * Estate has had no authentication at all: `AUTH=none`, a page listing every
 * server's IP and open ports, readable by anyone who resolves the hostname.
 * The admin panel writes configuration and starts processes, so that had to
 * change before any of it could ship.
 *
 * The identity comes from Google (OAuth 2.0, an OAuth client created in the
 * Google Cloud console). Estate never sees or stores a password, and the only
 * question it answers for itself is "is this verified address on the list".
 *
 * No dependencies. Everything here is node:crypto and fetch.
 *
 * Threat model, and what covers each part:
 *
 *   forged session cookie    HMAC-SHA256 over the payload with SESSION_SECRET,
 *                            compared in constant time
 *   stolen session cookie    HttpOnly + Secure + SameSite=Lax, short expiry
 *   login CSRF               signed `state`, bound to a single-use cookie
 *   forged ID token          RS256 verified against Google's published JWKS,
 *                            then iss / aud / exp / email_verified checked
 *   someone else's Google     the allowlist. A valid Google login by an address
 *     account                 that is not on it is refused
 *   form CSRF on writes      per-session token, required on every POST
 *   header spoofing          nothing is trusted from a header; the session is
 *                            cryptographic and the server binds to loopback
 */

import crypto from 'node:crypto';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];

export const SESSION_COOKIE = 'kw_estate_session';
export const STATE_COOKIE = 'kw_estate_oauth';
/** Eight hours. Long enough for a working day, short enough that a stolen laptop expires. */
export const SESSION_TTL_SEC = 8 * 3600;
const STATE_TTL_SEC = 600;

/* ------------------------------------------------------------- base64url */

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/* --------------------------------------------------------------- signing */

/**
 * Constant-time compare. `===` on a MAC leaks how much of the forgery was
 * right, one byte at a time, which is enough to construct a valid one.
 */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** `<payload-b64url>.<hmac-b64url>` */
export function sign(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

/**
 * Verify and decode. Returns null on a bad signature, malformed input, or an
 * expired `exp` — one return value for every failure, because a caller that
 * has to distinguish them will eventually get it wrong.
 */
export function unsign(token, secret, { now = Date.now() } = {}) {
  const [body, mac] = String(token ?? '').split('.');
  if (!body || !mac) return null;
  const expected = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  if (!safeEqual(mac, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(unb64u(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= now) return null;
  return payload;
}

/* --------------------------------------------------------------- cookies */

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      out[name] = part.slice(at + 1).trim();
    }
  }
  return out;
}

/**
 * `secure` is derived from the deployed base URL, not hardcoded. Setting
 * Secure on a plain-http localhost run means the cookie is silently dropped
 * and the operator sees an endless redirect loop with nothing explaining it.
 */
export function cookie(name, value, {
  maxAge = SESSION_TTL_SEC, secure = true, clear = false,
} = {}) {
  return [
    `${name}=${clear ? '' : encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : null,
    `Max-Age=${clear ? 0 : maxAge}`,
  ].filter(Boolean).join('; ');
}

/* ----------------------------------------------------------- allowlist */

/**
 * Is this verified address allowed in?
 *
 * Exact addresses, lowercased and trimmed, plus an optional domain for "anyone
 * at kwgroup.in". An empty allowlist denies everyone rather than allowing
 * everyone: a missing config must never be the thing that opens the door.
 */
export function isAllowed(email, { allowedEmails = [], allowedDomain = null } = {}) {
  const want = String(email ?? '').trim().toLowerCase();
  if (!want || !want.includes('@')) return false;

  const list = allowedEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  if (list.includes(want)) return true;

  if (allowedDomain) {
    const domain = String(allowedDomain).trim().toLowerCase().replace(/^@/, '');
    // Compared against the part after the LAST @, so
    // "attacker@evil.com@kwgroup.in" style inputs cannot pass. Google would
    // not issue such an address, but the check costs nothing.
    if (domain && want.slice(want.lastIndexOf('@') + 1) === domain) return true;
  }
  return false;
}

/* --------------------------------------------------------- Google OAuth */

/**
 * The admin server's own port. Kept here rather than only in admin.js because
 * the DEFAULT baseUrl has to agree with it: a default of :4178 (the static
 * serve port) against a server listening on :4179 builds a redirect_uri that
 * Google rejects, and the error says "redirect_uri_mismatch" without saying
 * which half is wrong.
 */
export const DEFAULT_ADMIN_PORT = 4179;

export function oauthConfig(env = process.env, { baseUrl } = {}) {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const sessionSecret = env.SESSION_SECRET;
  const missing = [
    !clientId && 'GOOGLE_CLIENT_ID',
    !clientSecret && 'GOOGLE_CLIENT_SECRET',
    !sessionSecret && 'SESSION_SECRET',
  ].filter(Boolean);
  return {
    clientId,
    clientSecret,
    sessionSecret,
    // localhost, not 127.0.0.1. Google treats them as different redirect URIs
    // and only one can be registered without registering both, so the default
    // picks the one its own console offers first.
    baseUrl: String(baseUrl ?? env.ADMIN_BASE_URL
      ?? `http://localhost:${env.ADMIN_PORT ?? DEFAULT_ADMIN_PORT}`).replace(/\/+$/, ''),
    missing,
    get redirectUri() { return `${this.baseUrl}/auth/callback`; },
    get secure() { return this.baseUrl.startsWith('https://'); },
  };
}

/**
 * Where to send the browser, plus the cookie that proves the reply came back
 * to the same browser that left.
 *
 * `state` is signed AND mirrored in a single-use cookie. The signature alone
 * proves we minted it; the cookie proves it is being redeemed by the session
 * that asked for it, which is what stops an attacker completing a login into
 * somebody else's browser.
 */
export function startLogin(config, { returnTo = '/', nonce = crypto.randomBytes(16).toString('hex'), now = Date.now() } = {}) {
  const payload = {
    n: nonce,
    r: safeReturnTo(returnTo),
    exp: Math.floor(now / 1000) + STATE_TTL_SEC,
  };
  const state = sign(payload, config.sessionSecret);

  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  // A fresh consent is not wanted on every visit, but an account chooser is:
  // several people here have more than one Google account signed in.
  url.searchParams.set('prompt', 'select_account');
  if (config.allowedDomain) url.searchParams.set('hd', config.allowedDomain);

  return {
    url: url.toString(),
    // The nonce, not the whole state: the cookie only has to prove sameness.
    stateCookie: cookie(STATE_COOKIE, nonce, { maxAge: STATE_TTL_SEC, secure: config.secure }),
  };
}

/**
 * Only ever redirect to a path on this site.
 *
 * `returnTo` arrives in a query string. Echoed into a Location header without
 * this, `/login?returnTo=https://evil.example` turns the login into an open
 * redirect that borrows Estate's hostname for a phishing page.
 */
export function safeReturnTo(value) {
  const raw = String(value ?? '/');
  // A protocol-relative "//evil.example" is a URL, not a path.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (raw.includes('\\') || /[\r\n]/.test(raw)) return '/';
  return raw;
}

/** Google's signing keys, cached for an hour. Refetched on an unknown kid. */
let jwksCache = { at: 0, keys: [] };

export async function googleKeys({ fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  if (!force && jwksCache.keys.length && now - jwksCache.at < 3600000) return jwksCache.keys;
  const res = await fetchImpl(GOOGLE_JWKS, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`could not fetch Google's signing keys: HTTP ${res.status}`);
  const body = await res.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  if (!keys.length) throw new Error("Google's JWKS came back empty");
  jwksCache = { at: now, keys };
  return keys;
}

/** For tests, and for a key rotation that must not wait out the cache. */
export function resetJwksCache(keys = []) {
  jwksCache = keys.length ? { at: Date.now(), keys } : { at: 0, keys: [] };
}

/**
 * Verify a Google ID token properly.
 *
 * The signature is checked before anything inside the token is believed. A
 * decoded-but-unverified JWT is attacker-controlled JSON, and treating its
 * `email` as an identity is the whole bug class this function exists to avoid.
 */
export async function verifyIdToken(idToken, config, { fetchImpl = fetch, now = Date.now(), keys = null } = {}) {
  const parts = String(idToken ?? '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'the ID token is not a JWT' };

  let header;
  let claims;
  try {
    header = JSON.parse(unb64u(parts[0]).toString('utf8'));
    claims = JSON.parse(unb64u(parts[1]).toString('utf8'));
  } catch {
    return { ok: false, error: 'the ID token is not readable' };
  }
  if (header.alg !== 'RS256') {
    // "alg": "none" and HMAC-with-the-public-key are the classic JWT forgeries.
    // Google signs with RS256; anything else is refused rather than negotiated.
    return { ok: false, error: `unexpected signing algorithm "${header.alg}"` };
  }

  const list = keys ?? await googleKeys({ fetchImpl, now });
  let jwk = list.find((k) => k.kid === header.kid);
  if (!jwk && !keys) {
    jwk = (await googleKeys({ fetchImpl, now, force: true })).find((k) => k.kid === header.kid);
  }
  if (!jwk) return { ok: false, error: 'the ID token was signed with a key Google does not publish' };

  let verified = false;
  try {
    verified = crypto.createVerify('RSA-SHA256')
      .update(`${parts[0]}.${parts[1]}`)
      .verify(crypto.createPublicKey({ key: jwk, format: 'jwk' }), unb64u(parts[2]));
  } catch (e) {
    return { ok: false, error: `could not verify the ID token: ${e.message}` };
  }
  if (!verified) return { ok: false, error: 'the ID token signature does not check out' };

  if (!GOOGLE_ISS.includes(claims.iss)) return { ok: false, error: `unexpected issuer "${claims.iss}"` };
  if (claims.aud !== config.clientId) return { ok: false, error: 'the ID token was issued for a different OAuth client' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return { ok: false, error: 'the ID token has expired' };
  // An unverified address can be anything the account holder typed. Allowing
  // one lets somebody claim an address on the allowlist that is not theirs.
  if (claims.email_verified !== true) return { ok: false, error: 'that Google account has not verified its email address' };
  if (!claims.email) return { ok: false, error: 'the ID token carries no email address' };

  return { ok: true, email: String(claims.email).toLowerCase(), name: claims.name ?? null, picture: claims.picture ?? null };
}

/** Swap the authorization code for tokens. The secret never leaves the server. */
export async function exchangeCode(code, config, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Google's error text can echo the redirect_uri and the client id. Neither
    // is secret, but the description is the useful part and the rest is noise.
    return { ok: false, error: `Google refused the code exchange: ${body.error ?? res.status}`
      + `${body.error_description ? ` — ${body.error_description}` : ''}` };
  }
  if (!body.id_token) return { ok: false, error: 'Google returned no ID token' };
  return { ok: true, idToken: body.id_token };
}

/* -------------------------------------------------------------- session */

export function issueSession(email, config, { name = null, now = Date.now() } = {}) {
  const payload = {
    email,
    name,
    // A per-session CSRF token. Carried inside the signed cookie, echoed in
    // every form, and compared on every write.
    csrf: crypto.randomBytes(16).toString('hex'),
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + SESSION_TTL_SEC,
  };
  return {
    token: sign(payload, config.sessionSecret),
    payload,
    setCookie: cookie(SESSION_COOKIE, sign(payload, config.sessionSecret), {
      maxAge: SESSION_TTL_SEC, secure: config.secure,
    }),
  };
}

/**
 * The session on a request, or null.
 *
 * The allowlist is re-checked on EVERY request, not just at login. Removing
 * somebody from the config has to take effect now, not in eight hours when
 * their cookie happens to expire.
 */
export function sessionFrom(req, config, admin, { now = Date.now() } = {}) {
  const cookies = parseCookies(req.headers?.cookie);
  const payload = unsign(cookies[SESSION_COOKIE], config.sessionSecret, { now });
  if (!payload?.email) return null;
  if (!isAllowed(payload.email, admin)) return null;
  return payload;
}

/**
 * Double-submit CSRF check for state-changing requests.
 *
 * SameSite=Lax already blocks a cross-site form POST, so this is the second
 * layer rather than the only one — but these endpoints write configuration and
 * start processes, and one browser quirk should not be all that stands between
 * a malicious page and that.
 */
export function csrfOk(session, token) {
  return Boolean(session?.csrf) && safeEqual(session.csrf, String(token ?? ''));
}
