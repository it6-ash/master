import test from 'node:test';
import assert from 'node:assert/strict';

import { targetsFrom, testLead, checkIssues, shouldReport, localTime } from '../src/check.js';

test('the report clock is the reader\'s, not the server\'s', () => {
  // srv1340120 runs Etc/UTC. A naive 09:30 would mail at 15:00 in Delhi, and
  // the only symptom would be mail that keeps arriving after lunch.
  const t = new Date('2026-08-26T04:00:00Z');
  assert.equal(localTime(t, 'Asia/Kolkata'), '09:30');
  assert.equal(localTime(t, 'Etc/UTC'), '04:00');
});

test('one digest a day, but a new failure does not wait for morning', () => {
  const at930 = new Date('2026-08-26T04:00:00Z');   // 09:30 IST
  const at1200 = new Date('2026-08-26T06:30:00Z');  // 12:00 IST
  const before930 = new Date('2026-08-26T02:00:00Z'); // 07:30 IST
  const report = (fails = []) => ({
    today: '2026-08-26',
    sites: [{ host: 'a.com', ok: true }, ...fails.map((h) => ({ host: h, ok: false }))],
    forms: [],
  });

  assert.equal(shouldReport(report(), {}, { previous: null, now: before930 }).yes, false,
    'nothing before the reporting hour');
  assert.equal(shouldReport(report(), {}, { previous: null, now: at930 }).yes, true,
    'the daily digest');
  assert.equal(
    shouldReport(report(), {}, { previous: { lastReported: '2026-08-26' }, now: at1200 }).yes,
    false, 'already sent today — the other four passes stay quiet',
  );

  // A site that broke at 11:00 must not wait until 09:30 tomorrow.
  const fresh = shouldReport(report(['b.com']), {}, {
    previous: { lastReported: '2026-08-26', sites: [{ host: 'a.com', ok: true }], forms: [] },
    now: at1200,
  });
  assert.equal(fresh.yes, true);
  assert.match(fresh.why, /newly failing: b\.com/);

  // The same failure again is not news.
  assert.equal(shouldReport(report(['b.com']), {}, {
    previous: { lastReported: '2026-08-26', sites: [{ host: 'b.com', ok: false }], forms: [] },
    now: at1200,
  }).yes, false);

  assert.equal(shouldReport(report(['b.com']), { alertOnNewFailures: false }, {
    previous: { lastReported: '2026-08-26', sites: [], forms: [] },
    now: at1200,
  }).yes, false, 'opt out and the morning mail is the only mail');
});

test('targets come from the servers, not from a maintained list', () => {
  const servers = {
    srv1: {
      vhosts: [
        { domain: 'kwgroup.in', source: 'nginx' },
        { domain: 'www.kwgroup.in', source: 'nginx' },
        { domain: 'n8n.srv1340120.hstgr.cloud', source: 'nginx' },
        { domain: 'srv1340120.hstgr.cloud', source: 'nginx' },
        { domain: '_', source: 'nginx' },
        { domain: 'kwatch.leadq.co.in', source: 'cloudflared' },
      ],
    },
    srv2: { vhosts: [{ domain: 'kwgroup.in' }] },
  };

  const hosts = targetsFrom(servers).map((t) => t.host);
  // n8n.srv1340120.hstgr.cloud IS checked; srv1340120.hstgr.cloud is not.
  // Excluding the whole suffix let n8n serve the wrong certificate unnoticed.
  assert.deepEqual(hosts, [
    'kwatch.leadq.co.in', 'kwgroup.in', 'n8n.srv1340120.hstgr.cloud', 'www.kwgroup.in',
  ]);

  // www. is its own hostname and can break on its own, so it is NOT collapsed.
  // *.hstgr.cloud is provider-issued and nobody visits it. `_` is a catch-all.
  assert.equal(targetsFrom(servers).find((t) => t.host === 'kwgroup.in').server, 'srv1',
    'first server to claim a hostname owns it');
  assert.deepEqual(targetsFrom(servers, { skip: ['kwgroup.in'] }).map((t) => t.host),
    ['kwatch.leadq.co.in', 'n8n.srv1340120.hstgr.cloud', 'www.kwgroup.in']);
});

test('extra targets cover pages the estate does not serve', () => {
  // The ad landing pages are on domains none of the three boxes has heard of,
  // so nothing derives them — and they are where the leads come from.
  const t = targetsFrom({ s1: { vhosts: [{ domain: 'kwgroup.in' }] } }, {
    extra: [
      'https://kwdelhi6ghaziabad.com/kw-delhi-6-raj-nagar-extension.html',
      'https://kwdelhi6ghaziabad.com/',
      'not a url',
      { url: 'https://y.com/z', label: 'custom' },
    ],
  });

  assert.deepEqual(t.map((x) => x.host), [
    'custom',
    'kwdelhi6ghaziabad.com',
    'kwdelhi6ghaziabad.com/kw-delhi-6-raj-nagar-extension.html',
    'kwgroup.in',
  ]);
  // Labelled by path, because sixteen rows reading "kwdelhi6ghaziabad.com"
  // would not tell you which page is broken.
  assert.equal(t.find((x) => x.host.includes('raj-nagar')).server, null, 'not on one of our servers');
  assert.equal(t.find((x) => x.host.includes('raj-nagar')).source, 'configured');
  assert.ok(!t.some((x) => x.host === 'not a url'), 'an unparseable entry is dropped, not probed');
});

test('a test lead is obviously a test lead', () => {
  const form = {
    id: 'kwdelhi6ghaziabad',
    fields: {
      full_name: 'name', email: 'email', mobile: 'phone', msg: 'message',
      source: 'kw-estate-uptime-check',
    },
  };
  const lead = testLead(form, { today: '2026-08-26' });

  // Both questions you have while looking at the CRM row — which site, and
  // when — on every identifier, because which column you can see depends on
  // the view. Two landing domains produced identical-looking leads before this.
  assert.equal(lead.full_name, 'KW Estate monitor · kwdelhi6ghaziabad · 2026-08-26');
  assert.match(lead.email, /\+kwdelhi6ghaziabad-2026-08-26@/, 'site and date, plus-addressed');
  assert.notEqual(
    testLead({ ...form, id: 'kwbluepearldelhi' }, { today: '2026-08-26' }).full_name,
    lead.full_name,
    'the two landing domains must be tellable apart at a glance',
  );
  assert.equal(lead.mobile, '9000082626', 'phone reads 9000 MMDD YY');
  assert.equal(lead.mobile.length, 10, 'ten digits');
  // Must satisfy the same rule the sites do, or a validating form rejects the
  // submission and the check reports a working form as broken.
  assert.ok(/^[6-9]\d{9}$/.test(lead.mobile), 'a well-formed Indian mobile');
  assert.notEqual(testLead(form, { today: '2026-08-27' }).mobile, lead.mobile, 'unique per day');
  // A site that validates strictly can still be given a number KW controls.
  assert.equal(testLead({ ...form, phone: '9876543210' }, { today: '2026-08-26' }).mobile, '9876543210');
  assert.match(lead.msg, /Not a real enquiry/);
  // Anything that is not a placeholder name is sent through literally.
  assert.equal(lead.source, 'kw-estate-uptime-check');
  // Only the configured fields are sent — no surprise keys into someone's CRM.
  assert.deepEqual(Object.keys(lead).sort(), ['email', 'full_name', 'mobile', 'msg', 'source']);
});

test('accepted-but-absent is a different finding from rejected', () => {
  const base = { today: '2026-08-26', at: '2026-08-26T05:00:00Z', sites: [] };

  const rejected = checkIssues({ ...base, forms: [{ id: 'f', url: 'u', ok: false, status: 500 }] });
  assert.equal(rejected[0].rule, 'form-broken');

  // The page said thank-you and the CRM never saw it. Worst case, and the one
  // nobody notices, because everything visible looks fine.
  const lost = checkIssues({
    ...base,
    forms: [{ id: 'f', url: 'u', ok: false, accepted: true, status: 200, verified: { attempted: true, found: false, attempt: 3, afterMs: 30000 } }],
  });
  assert.equal(lost[0].rule, 'lead-not-in-crm');
  assert.equal(lost[0].severity, 'critical');
  assert.match(lost[0].body, /30s/);

  // Cannot reach the CRM is not proof the lead is missing, and must not page
  // someone at the same level as a lost enquiry.
  const blind = checkIssues({
    ...base,
    forms: [{ id: 'f', url: 'u', ok: false, accepted: true, status: 200, verified: { attempted: true, found: false, error: 'ETIMEDOUT' } }],
  });
  assert.equal(blind[0].rule, 'crm-unreachable');
  assert.equal(blind[0].severity, 'medium');

  // Verified present: no issue at all.
  assert.deepEqual(checkIssues({
    ...base,
    forms: [{ id: 'f', url: 'u', ok: true, accepted: true, status: 200, verified: { attempted: true, found: true } }],
  }), []);
});

test('a broken form outranks a down site, and a skipped one raises nothing', () => {
  const report = {
    today: '2026-08-26',
    at: '2026-08-26T05:00:00Z',
    sites: [
      { host: 'a.example.com', url: 'https://a.example.com/', ok: false, error: 'ENOTFOUND', server: 'srv1' },
      { host: 'b.example.com', url: 'https://b.example.com/', ok: true, status: 200, ms: 120, server: 'srv1' },
      { host: 'c.example.com', url: 'https://c.example.com/', ok: true, status: 200, ms: 8065, server: 'srv2' },
    ],
    forms: [
      { id: 'kwgroup-lead', url: 'https://kwgroup.in/x', ok: false, status: 500 },
      { id: 'other', url: 'https://x/y', ok: false, skipped: true, reason: '--no-forms' },
    ],
  };

  const issues = checkIssues(report);
  const byRule = Object.fromEntries(issues.map((i) => [i.rule, i]));

  assert.equal(issues.length, 3, 'down site, slow site, broken form — the skipped form raises nothing');
  assert.equal(byRule['form-broken'].severity, 'critical', 'a lost enquiry costs more than a down internal page');
  assert.equal(byRule['site-unreachable'].severity, 'high');
  assert.equal(byRule['site-slow'].severity, 'medium');
  assert.match(byRule['site-slow'].title, /8\.1s/);
  assert.equal(byRule['site-unreachable'].server, 'srv1');
  for (const i of issues) assert.match(i.id, /^[a-z0-9][a-z0-9-]*$/, `${i.id} must satisfy the issues schema`);
});
