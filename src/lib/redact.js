/**
 * Credential detection and redaction.
 *
 * ONE pattern table, TWO consumers:
 *   - ingest calls redactDeep()  before anything is written to data/
 *   - validate calls scanDeep()  to prove nothing credential-shaped got through
 *
 * Because both sides share this table, "validate passes" genuinely means
 * "ingest would have redacted everything validate can see". Adding a pattern
 * here strengthens both at once.
 *
 * Bias: over-redact. A dashboard tile reading [REDACTED:assigned-secret]
 * is a minor annoyance; a token committed to git is not.
 */

/**
 * Our own marker, plus the ones kw-collect.sh writes at source
 * (***REDACTED***, ***GITHUB_TOKEN***, ***OPENAI_KEY***, …). Recognising the
 * collector's markers keeps us from "re-redacting" text that is already safe,
 * which would otherwise make every committed fixture look like it leaks.
 */
export const PLACEHOLDER_RE = /\[REDACTED:[a-z0-9-]+\]|\*{3}[A-Z][A-Z0-9_]*\*{3}/;

/** Values that look assigned-secret-shaped but never are. */
const NON_SECRETS = new Set([
  'true', 'false', 'yes', 'no', 'on', 'off', 'none', 'null', 'nil', 'undefined',
  'enabled', 'disabled', 'enable', 'disable', 'active', 'inactive',
  'required', 'optional', 'default', 'unset', 'empty', 'changeme',
  'string', 'number', 'boolean', 'object', 'array',
]);

const keep = (v) => NON_SECRETS.has(String(v).toLowerCase()) || PLACEHOLDER_RE.test(String(v));

/**
 * True if `text` already carries a redaction marker — ours or the collector's.
 *
 * Needed because "we redacted nothing" and "there is no secret here" are
 * different statements. A crontab line the collector already sanitised still
 * describes a credential, and must still be flagged hasSecret.
 */
export const isRedacted = (text) => PLACEHOLDER_RE.test(String(text ?? ''));

/**
 * Each pattern owns a global regex and a replacer that preserves surrounding
 * structure so a redacted cron line still reads as a cron line.
 */
export const PATTERNS = [
  {
    kind: 'private-key-block',
    re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    replace: () => '[REDACTED:private-key-block]',
  },
  {
    // scheme://user:password@host — mongodb://, postgres://, amqp://, https:// …
    kind: 'uri-credentials',
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]{1,64}):([^\s@/]{1,256})@/gi,
    replace: (m, scheme, user, pass) => (keep(pass) ? m : `${scheme}${user}:[REDACTED:uri-credentials]@`),
  },
  {
    kind: 'aws-access-key',
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
    replace: () => '[REDACTED:aws-access-key]',
  },
  {
    kind: 'anthropic-key',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    replace: () => '[REDACTED:anthropic-key]',
  },
  {
    kind: 'openai-key',
    re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    replace: () => '[REDACTED:openai-key]',
  },
  {
    kind: 'github-token',
    re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
    replace: () => '[REDACTED:github-token]',
  },
  {
    kind: 'slack-token',
    re: /\bxox[baprse]-[A-Za-z0-9-]{10,}/g,
    replace: () => '[REDACTED:slack-token]',
  },
  {
    kind: 'google-api-key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => '[REDACTED:google-api-key]',
  },
  {
    kind: 'telegram-bot-token',
    re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
    replace: () => '[REDACTED:telegram-bot-token]',
  },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: () => '[REDACTED:jwt]',
  },
  {
    kind: 'auth-header',
    re: /\b(Authorization\s*:\s*(?:Basic|Bearer|Token)\s+)([A-Za-z0-9+/=._-]{10,})/gi,
    replace: (m, head) => `${head}[REDACTED:auth-header]`,
  },
  {
    // mysql -pSECRET / mysqldump -pSECRET — scoped to a mysql-ish command so
    // `mkdir -p` and `docker run -p` cannot trip it.
    kind: 'mysql-inline-password',
    re: /\b(mysql(?:dump|admin|check)?|mariadb)\b([^\n]{0,120}?)(-p)(?!\s)(\S{4,})/gi,
    replace: (m, cmd, mid, flag) => `${cmd}${mid}${flag}[REDACTED:mysql-inline-password]`,
  },
  {
    // --password VALUE / -token VALUE. Requires a leading dash: a bare word
    // followed by a space is far too common to treat as an assignment.
    kind: 'flag-secret',
    re: /(--?(?:pass(?:word|wd)?|passphrase|token|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token)[= ]\s*)(['"]?)([^\s'"]{4,})\2/gi,
    replace: (m, head, q, val) => (keep(val) ? m : `${head}${q}[REDACTED:flag-secret]${q}`),
  },
  {
    // KEY=value or "key": "value", with an EXPLICIT assignment operator.
    //
    // Two ways to be a secret-shaped name:
    //   SECRET_WORD  a known keyword          password / api_key / bearer
    //   ENV_SUFFIX   *_KEY, *_SECRET, *_TOKEN N8N_ENCRYPTION_KEY, JWT_SECRET
    //
    // The lookbehind is (?<![A-Za-z0-9]) rather than \b on purpose: `_` is a
    // word character, so \b never fires in DB_PASSWORD or N8N_ENCRYPTION_KEY —
    // exactly the shapes that leak out of .env files and crontabs. It still
    // refuses to match inside hasSecret / secretKinds, where the preceding
    // character is a letter.
    kind: 'assigned-secret',
    re: new RegExp(
      '(?<![A-Za-z0-9])('
      + '(?:[A-Z0-9_]{2,40}_(?:KEY|SECRET|TOKEN|PASS|PASSWORD|PWD|CREDENTIALS?)'
      + '|pass(?:word|wd)?|passphrase|secret|token|api[_-]?key|apikey'
      + '|access[_-]?key|secret[_-]?key|private[_-]?key|credential|bearer)'
      // the [\'"]? after the key allows a quoted JSON key: "password": "…"
      + '\\w*)[\'"]?(\\s*[:=]\\s*)([\'"]?)([^\\s\'"#,;]{6,})\\3',
      'gi',
    ),
    replace: (m, key, sep, q, val) => (keep(val) ? m : `${key}${sep}${q}[REDACTED:assigned-secret]${q}`),
  },
];

/* ------------------------------------------------------------------ core */

/**
 * @param {string} s
 * @returns {{ text: string, kinds: string[] }}
 */
export function redactString(s) {
  if (typeof s !== 'string' || s.length === 0) return { text: s, kinds: [] };
  let text = s;
  const kinds = new Set();
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    text = text.replace(p.re, (...args) => {
      const out = p.replace(...args);
      if (out !== args[0]) kinds.add(p.kind);
      return out;
    });
  }
  return { text, kinds: [...kinds] };
}

/**
 * Non-mutating detection. Returns one finding per pattern that fires, with a
 * SAFE preview: the snippet is returned already redacted, so callers can print
 * findings without re-leaking the secret they just found.
 *
 * @param {string} s
 * @returns {Array<{kind: string, preview: string}>}
 */
export function scanString(s) {
  if (typeof s !== 'string' || s.length === 0) return [];
  const findings = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(s)) !== null) {
      const replaced = p.replace(...m, m.index, s);
      if (replaced === m[0]) {
        if (m[0].length === 0) p.re.lastIndex += 1;
        continue; // replacer declined (allowlisted value)
      }
      const start = Math.max(0, m.index - 24);
      const end = Math.min(s.length, m.index + m[0].length + 24);
      const snippet = (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : '');
      findings.push({ kind: p.kind, preview: redactString(snippet).text });
      if (m[0].length === 0) p.re.lastIndex += 1;
      break; // one finding per pattern per string is enough to fail validate
    }
  }
  return findings;
}

/* ------------------------------------------------------------ deep walks */

/**
 * Recursively redact every string in a structure. Object KEYS are left alone —
 * they are field names we control, never captured values.
 *
 * @returns {{ value: any, kinds: string[] }}
 */
export function redactDeep(input) {
  const kinds = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      const { text, kinds: k } = redactString(v);
      k.forEach((x) => kinds.add(x));
      return text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(v)) out[key] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(input), kinds: [...kinds] };
}

/**
 * Recursively scan every string in a parsed structure.
 * Scanning parsed VALUES rather than raw JSON text means JSON punctuation and
 * our own field names (`hasSecret`, `secretKinds`) can never false-positive.
 *
 * @returns {Array<{path: string, kind: string, preview: string}>}
 */
export function scanDeep(input, basePath = '') {
  const findings = [];
  const walk = (v, path) => {
    if (typeof v === 'string') {
      for (const f of scanString(v)) findings.push({ path: path || '/', ...f });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}/${i}`));
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const [key, val] of Object.entries(v)) walk(val, `${path}/${key}`);
    }
  };
  walk(input, basePath);
  return findings;
}
