#!/usr/bin/env node
/**
 * npm run check — probe every hostname the estate serves, submit the lead
 * forms, write the results into data/, and post a report to n8n for mailing.
 *
 *   npm run check                 probe, submit forms, report
 *   npm run check -- --no-forms   probe only; write nothing to any CRM
 *   npm run check -- --dry-run    print what it would do, touch nothing
 *
 * The target list is DERIVED: every vhost the collector found, minus anything
 * in `skip`. A site deployed today is checked today, without anyone editing a
 * list. Forms are the opposite — they are only ever submitted when explicitly
 * configured, because a form post writes to a real CRM and guessing at one is
 * how you fill somebody's pipeline with junk.
 *
 * config/checks.json is git-ignored. Copy config/checks.example.json.
 */

import path from 'node:path';

import { ROOT, abs, readJson, writeJsonIfChanged } from './lib/fsx.js';
import { isoDate } from './lib/units.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noForms = args.includes('--no-forms');
// The probes run four times a day; the forms should not. Each submission is a
// real lead in a real CRM, and four a day per landing page is somebody else's
// afternoon spent deleting them.
const forceForms = args.includes('--force-forms');
const forceReport = args.includes('--force-report');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (color ? `[${c}m${s}[0m` : s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const dim = (s) => paint('2', s);

const TIMEOUT_MS = 20000;
// Not a round number pulled from nowhere: past ~5s a marketing page has lost
// most of the visitor. Raise it before you find yourself ignoring the issue.
const SLOW_MS = 5000;

/* --------------------------------------------------------------- targets */

/**
 * Hostnames worth probing, from the servers themselves.
 *
 * Provider-issued names are dropped: *.hstgr.cloud answers, but nobody visits
 * it and a cert warning there is noise. A bare catch-all `_` is not a hostname.
 */
export function targetsFrom(servers, { skip = [], extra = [] } = {}) {
  const seen = new Map();
  for (const [id, server] of Object.entries(servers)) {
    for (const vhost of server.vhosts ?? []) {
      const host = String(vhost.domain ?? '').toLowerCase();
      if (!host || host === '_' || !host.includes('.')) continue;
      if (host.endsWith('.hstgr.cloud')) continue;
      if (skip.includes(host)) continue;
      if (seen.has(host)) continue;
      seen.set(host, { host, server: id, url: `https://${host}/`, source: vhost.source ?? 'nginx' });
    }
  }

  // Anything the estate does not serve. The landing pages live with an ad
  // agency, on domains none of these three boxes has ever heard of, so no
  // amount of collecting will discover them — but they are where the leads
  // come from, which makes them the pages that most need watching.
  //
  // Labelled by host + path, because sixteen rows all reading
  // "kwdelhi6ghaziabad.com" tell you nothing about which one is broken.
  for (const entry of extra) {
    const url = typeof entry === 'string' ? entry : entry.url;
    if (!url) continue;
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    const label = (typeof entry === 'object' && entry.label)
      || `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    if (skip.includes(label) || seen.has(label)) continue;
    seen.set(label, { host: label, server: null, url, source: 'configured' });
  }

  return [...seen.values()].sort((a, b) => a.host.localeCompare(b.host));
}

/* ---------------------------------------------------------------- probes */

async function probe(target) {
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'kw-estate-check/1.0 (+internal uptime check)' },
    });
    const body = await res.text();
    return {
      ...target,
      ok: res.status < 400,
      status: res.status,
      ms: Date.now() - started,
      finalUrl: res.url !== target.url ? res.url : undefined,
      bytes: body.length,
      // A 200 that serves nothing is still a broken site.
      empty: res.status < 400 && body.trim().length < 200 ? true : undefined,
      body,
    };
  } catch (e) {
    return {
      ...target,
      ok: false,
      ms: Date.now() - started,
      // "fetch failed" alone never tells you which of DNS, TLS or refused it was.
      error: `${e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.message)}`,
    };
  }
}

/* ----------------------------------------------------------------- forms */

/**
 * A submission that is obviously a test at a glance in the CRM: same name
 * every time, a phone nobody can dial, and a plus-addressed email carrying the
 * date. Whoever works the leads must be able to filter these out in one rule.
 */
export function testLead(form, { today }) {
  const marker = form.marker ?? 'KW Estate monitor';
  const [y, m, d] = today.split('-');

  // Ten digits so length validation passes, but four leading zeros mean no
  // Indian mobile can ever be this — nobody real gets called, and the date is
  // readable straight off the number: 0000 MMDD YY.
  const phone = `0000${m}${d}${y.slice(2)}`;

  const defaults = {
    // The date in the name too: in a CRM list view you see the name column
    // first, and "which day was this" is the question you have while looking
    // at it.
    name: `${marker} ${today}`,
    email: `estate-monitor+${today}@kwgroup.in`,
    phone,
    message: `Automated availability check from the KW Estate dashboard, ${today}. Not a real enquiry — safe to delete.`,
  };
  const out = {};
  for (const [field, value] of Object.entries(form.fields ?? {})) {
    // "name" means "put the name here"; anything else is a literal.
    out[field] = Object.hasOwn(defaults, value) ? defaults[value] : value;
  }
  return out;
}

/**
 * Did the lead actually arrive in the CRM?
 *
 * This is the half that matters. A landing page can accept a submission, return
 * a cheerful 200, and drop it — a broken webhook, an expired API key, a
 * workflow switched off. Nothing anywhere reports that; enquiries just stop.
 * So after posting, look the lead up by the one thing that is unique to it: the
 * plus-addressed email.
 *
 * Deliberately generic rather than Cratio-specific. `verify.url` is whatever
 * search endpoint answers, with {email}, {phone} and {date} substituted in, and
 * `verify.match` is the string the response must contain. Cratio today, another
 * CRM later, no code change.
 *
 * Polled, because CRMs ingest asynchronously and a single immediate lookup
 * would report every working form as broken.
 */
async function verifyLead(form, payload, { today }) {
  const v = form.verify;
  if (!v?.url) return { attempted: false };

  const email = Object.values(payload).find((x) => String(x).includes('@')) ?? '';
  const phone = Object.values(payload).find((x) => /^\+?[\d ]{8,}$/.test(String(x))) ?? '';

  // Percent-encoding belongs in a URL and nowhere else. Encoding into a JSON
  // body would send estate-monitor%2B2026-08-26%40kwgroup.in and the CRM would
  // never match it.
  const fill = (s, encode) => String(s)
    .replaceAll('{email}', encode ? encodeURIComponent(email) : email)
    .replaceAll('{phone}', encode ? encodeURIComponent(phone) : phone)
    .replaceAll('{date}', today);

  const url = fill(v.url, true);
  const needle = String(fill(v.match ?? '{email}', false)).toLowerCase();
  const attempts = v.attempts ?? 3;
  const waitMs = v.waitMs ?? 10000;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await new Promise((r) => { setTimeout(r, waitMs); });
    try {
      const res = await fetch(url, {
        method: v.method ?? 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json', ...(v.headers ?? {}) },
        ...(v.body ? { body: fill(JSON.stringify(v.body), false) } : {}),
      });
      const text = await res.text();

      // A lookup that could not run is not a lead that went missing. Without
      // this, a wrong API key or a renamed CRM field raises "the form accepted
      // a lead that never arrived" — critical, alarming, and about the wrong
      // system entirely.
      const errorMatch = v.errorMatch ?? 'LEAD_ERROR';
      if (errorMatch && text.includes(errorMatch)) {
        return { attempted: true, found: false, attempt, error: `the lookup failed: ${text.slice(0, 160)}` };
      }

      // decodeURIComponent because a CRM may echo the address unencoded.
      if (text.toLowerCase().includes(decodeURIComponent(needle))) {
        return { attempted: true, found: true, attempt, afterMs: attempt * waitMs };
      }
      if (attempt === attempts) {
        return { attempted: true, found: false, attempt, afterMs: attempt * waitMs, status: res.status };
      }
    } catch (e) {
      if (attempt === attempts) {
        return {
          attempted: true,
          found: false,
          attempt,
          // Cannot reach the CRM is not the same as the lead is missing, and
          // treating them alike would page someone for an API outage.
          error: e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.message),
        };
      }
    }
  }
  return { attempted: true, found: false };
}

async function submitForm(form, { today }) {
  const payload = testLead(form, { today });
  const started = Date.now();

  if (dryRun || noForms) {
    return { ...form, skipped: true, reason: dryRun ? 'dry run' : '--no-forms', payload };
  }

  try {
    const isJson = (form.encoding ?? 'form') === 'json';
    const res = await fetch(form.url, {
      method: form.method ?? 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
        'user-agent': 'kw-estate-check/1.0 (+internal form check)',
        ...(form.headers ?? {}),
      },
      body: isJson ? JSON.stringify(payload) : new URLSearchParams(payload).toString(),
    });
    const body = await res.text();

    // A form that 200s and quietly drops the lead is the failure mode that
    // matters, so an expected string in the response is what "ok" means when
    // one is configured.
    const expected = form.expect ?? null;
    const matched = expected ? body.toLowerCase().includes(String(expected).toLowerCase()) : res.status < 400;

    const accepted = res.status < 400 && matched;
    // No point looking for a lead the page never accepted.
    const verified = accepted ? await verifyLead(form, payload, { today }) : { attempted: false };

    return {
      id: form.id,
      url: form.url,
      accepted,
      ok: accepted && (verified.attempted ? verified.found === true : true),
      status: res.status,
      ms: Date.now() - started,
      expected: expected ?? undefined,
      matched: expected ? matched : undefined,
      verified,
      payload,
    };
  } catch (e) {
    return {
      id: form.id,
      url: form.url,
      ok: false,
      ms: Date.now() - started,
      error: e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.message),
      payload,
    };
  }
}

/* ---------------------------------------------------------------- issues */

/** Failures the dashboard should carry next to the ones from the dumps. */
export function checkIssues(report) {
  const issues = [];

  for (const site of report.sites.filter((s) => !s.ok)) {
    issues.push({
      id: `site-unreachable-${site.host.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      severity: 'high',
      title: `${site.host} did not answer`,
      body: `A request to ${site.url} ${site.error ? `failed: ${site.error}` : `returned HTTP ${site.status}`}.`
        + ` Checked ${report.at}. This is an outside-in check, so it fails for DNS and certificate problems`
        + ' the server itself would report as healthy.',
      server: site.server,
      source: 'auto',
      rule: 'site-unreachable',
      evidence: site.error ?? `HTTP ${site.status}`,
      opened: report.today,
    });
  }

  // Up but unusable is still a problem, and it is one only an outside-in check
  // sees: the server reports a healthy nginx either way.
  for (const site of report.sites.filter((s) => s.ok && (s.ms ?? 0) >= SLOW_MS)) {
    issues.push({
      id: `site-slow-${site.host.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      severity: 'medium',
      title: `${site.host} took ${(site.ms / 1000).toFixed(1)}s to respond`,
      body: `First byte to full body took ${site.ms} ms from outside the estate, against a ${SLOW_MS / 1000}s threshold.`
        + ' Visitors leave well before that, and search ranking follows them.',
      server: site.server,
      source: 'auto',
      rule: 'site-slow',
      evidence: `${site.ms} ms`,
      opened: report.today,
    });
  }

  for (const form of report.forms.filter((f) => !f.ok && !f.skipped)) {
    const slug = String(form.id).replace(/[^a-z0-9]+/gi, '-').toLowerCase();

    // Accepted but never arrived is the worse of the two and needs saying
    // differently: the page looks perfect, so nobody goes looking.
    if (form.accepted && form.verified?.attempted && form.verified.found === false) {
      if (form.verified.error) {
        issues.push({
          id: `crm-unreachable-${slug}`,
          severity: 'medium',
          title: `Could not confirm the ${form.id} test lead — the CRM did not answer`,
          body: `The form accepted the submission, but the lookup failed: ${form.verified.error}.`
            + ' The lead may well be fine; this is the check being unable to see, not proof of loss.',
          source: 'auto',
          rule: 'crm-unreachable',
          evidence: form.verified.error,
          opened: report.today,
        });
        continue;
      }
      issues.push({
        id: `lead-not-in-crm-${slug}`,
        severity: 'critical',
        title: `${form.id}: the form accepted a lead that never reached the CRM`,
        body: `A test submission to ${form.url} returned HTTP ${form.status} and looked successful, but the lead`
          + ` was still not in the CRM after ${Math.round((form.verified.afterMs ?? 0) / 1000)}s.`
          + ' Enquiries are being accepted and silently dropped — the page shows a thank-you, the salesperson never'
          + ' sees the lead, and nobody finds out until someone asks why the phone stopped ringing.',
        source: 'auto',
        rule: 'lead-not-in-crm',
        evidence: `submitted, absent after ${form.verified.attempt ?? 0} lookups`,
        opened: report.today,
      });
      continue;
    }

    issues.push({
      id: `form-broken-${slug}`,
      severity: 'critical',
      title: `The ${form.id} lead form is not accepting submissions`,
      body: `A test submission to ${form.url} ${form.error ? `failed: ${form.error}` : `returned HTTP ${form.status}`}`
        + `${form.matched === false ? `, and the response did not contain "${form.expected}"` : ''}.`
        + ' Every enquiry through this form is being lost until it is fixed, and nothing on the server reports it.',
      source: 'auto',
      rule: 'form-broken',
      evidence: form.error ?? `HTTP ${form.status}`,
      opened: report.today,
    });
  }

  return issues;
}

/* ---------------------------------------------------------------- report */

/** Wall-clock HH:MM in the configured zone, not the server's. */
export function localTime(date, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

/**
 * Should this run mail anybody?
 *
 * One digest a day, at reportAt. The probes run five times daily and nobody
 * wants five identical "all healthy" mails — that is how a report becomes a
 * filter rule and then stops being read.
 *
 * The exception is a failure that was not in the last report. A digest that
 * sits on a new outage until tomorrow morning is a newsletter, not monitoring.
 * Set alertOnNewFailures to false if the morning mail is genuinely enough.
 */
export function shouldReport(report, config, { previous, now }) {
  const timezone = config.timezone ?? 'Asia/Kolkata';
  const at = config.reportAt ?? '09:30';

  if (localTime(now, timezone) >= at && previous?.lastReported !== report.today) {
    return { yes: true, why: `daily report, ${at} ${timezone}` };
  }

  if (config.alertOnNewFailures !== false) {
    const key = (f) => `${f.host ?? f.id}`;
    const before = new Set([
      ...(previous?.sites ?? []).filter((s) => !s.ok).map(key),
      ...(previous?.forms ?? []).filter((f) => !f.ok && !f.skipped).map(key),
    ]);
    const fresh = [
      ...report.sites.filter((s) => !s.ok).map(key),
      ...report.forms.filter((f) => !f.ok && !f.skipped).map(key),
    ].filter((k) => !before.has(k));
    if (fresh.length) return { yes: true, why: `newly failing: ${fresh.join(', ')}` };
  }

  return { yes: false, why: `holding until ${at} ${timezone}` };
}

async function postReport(report, config) {
  const url = config.webhook;
  if (!url) return { sent: false, reason: 'no webhook configured in config/checks.json' };
  if (dryRun) return { sent: false, reason: 'dry run' };

  const failures = [...report.sites.filter((s) => !s.ok), ...report.forms.filter((f) => !f.ok && !f.skipped)];
  const subject = failures.length
    ? `KW Estate: ${failures.length} check${failures.length === 1 ? '' : 's'} failing`
    : `KW Estate: all ${report.sites.length} sites healthy`;

  // `notify` takes one address or a list. Sent both ways because email nodes
  // differ: most want one comma-separated string, some want an array.
  const recipients = [config.notify ?? []].flat().filter(Boolean);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', ...(config.webhookHeaders ?? {}) },
      body: JSON.stringify({
        subject,
        to: recipients.join(', '),
        toList: recipients,
        cc: [config.cc ?? []].flat().filter(Boolean).join(', ') || undefined,
        at: report.at,
        healthy: failures.length === 0,
        summary: report.summary,
        failures: failures.map((f) => ({
          what: f.host ?? f.id,
          url: f.url,
          error: f.error ?? `HTTP ${f.status}`,
          server: f.server ?? null,
        })),
        sites: report.sites.map(({ body: _b, ...rest }) => rest),
        forms: report.forms,
      }),
    });
    return { sent: res.status < 400, status: res.status };
  } catch (e) {
    return { sent: false, reason: e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.message) };
  }
}

/* ------------------------------------------------------------------- run */

export async function runChecks() {
  const serversFile = readJson(abs('data', 'servers.json'));
  if (!serversFile.ok) {
    process.stdout.write(`${red('✗')} no data/servers.json — ingest a dump first\n`);
    return 1;
  }

  const configFile = readJson(abs('config', 'checks.json'));
  const config = configFile.ok ? configFile.value : {};
  const today = isoDate(new Date());
  const at = new Date().toISOString();

  // Carried forward from the last report: which forms have already been
  // submitted today. Kept in data/checks.json rather than a lock file so it
  // survives with the rest of the state and is visible when it misbehaves.
  const previous = readJson(abs('data', 'checks.json'));
  const lastSubmitted = { ...(previous.ok ? previous.value.lastSubmitted ?? {} : {}) };

  const targets = targetsFrom(serversFile.value, { skip: config.skip ?? [], extra: config.extra ?? [] });
  const forms = noForms ? [] : (config.forms ?? []);

  process.stdout.write(`\n${dim(at.replace('T', ' ').slice(0, 19))} checking ${targets.length} hostname${targets.length === 1 ? '' : 's'}`
    + `${forms.length ? ` and ${forms.length} form${forms.length === 1 ? '' : 's'}` : ''}\n`);

  // Concurrent: twenty sequential 20s timeouts is a six-minute check.
  const sites = await Promise.all(targets.map((t) => (dryRun
    ? Promise.resolve({ ...t, ok: true, status: 0, ms: 0, skipped: true })
    : probe(t))));

  for (const s of sites) {
    if (s.skipped) process.stdout.write(`${dim(`  · ${s.host} (dry run)`)}\n`);
    else if (s.ok && s.empty) process.stdout.write(`${yellow('  !')} ${s.host} — ${s.status} but the body is nearly empty\n`);
    else if (s.ok) process.stdout.write(`${green('  ✓')} ${s.host} ${dim(`${s.status} · ${s.ms}ms`)}\n`);
    else process.stdout.write(`${red('  ✗')} ${s.host} — ${s.error ?? `HTTP ${s.status}`}\n`);
  }

  const formResults = [];
  for (const form of forms) {
    if (!forceForms && lastSubmitted[form.id] === today) {
      // Carry today's real result forward rather than reporting nothing. A
      // broken form found at 06:07 must still be broken on the dashboard at
      // 12:07 — otherwise the finding disappears three runs out of four and
      // whoever looks after lunch sees a clean page.
      const earlier = (previous.ok ? previous.value.forms ?? [] : []).find((f) => f.id === form.id && !f.skipped);
      formResults.push(earlier
        ? { ...earlier, carried: true }
        : { id: form.id, url: form.url, skipped: true, reason: 'already submitted today' });
      process.stdout.write(`${dim(`  · ${form.id} submitted earlier today${earlier ? ` — ${earlier.ok ? 'was ok' : 'still failing'}` : ''}`)}\n`);
      continue;
    }

    const result = await submitForm(form, { today });
    // Record the attempt, not the success: a form that 500s must not be
    // retried on every pass for the rest of the day.
    if (!result.skipped) lastSubmitted[form.id] = today;
    formResults.push(result);
    if (result.skipped) process.stdout.write(`${dim(`  · ${form.id} not submitted (${result.reason})`)}\n`);
    else if (result.ok) process.stdout.write(`${green('  ✓')} ${form.id} ${dim(`${result.status} · ${result.ms}ms`)}\n`);
    else process.stdout.write(`${red('  ✗')} ${form.id} — ${result.error ?? `HTTP ${result.status}`}\n`);
  }

  const failed = sites.filter((s) => !s.ok).length + formResults.filter((f) => !f.ok && !f.skipped).length;
  const report = {
    at,
    today,
    summary: {
      sites: sites.length,
      sitesOk: sites.filter((s) => s.ok).length,
      forms: formResults.filter((f) => !f.skipped).length,
      formsOk: formResults.filter((f) => f.ok).length,
      failed,
      slowestMs: Math.max(0, ...sites.map((s) => s.ms ?? 0)),
    },
    // The page body is only needed while probing; storing it would put every
    // site's HTML into data/, and data/ is scanned for credentials for a reason.
    sites: sites.map(({ body: _b, ...rest }) => rest),
    forms: formResults,
    lastSubmitted,
  };

  const decision = forceReport
    ? { yes: true, why: '--force-report' }
    : shouldReport(report, config, { previous: previous.ok ? previous.value : null, now: new Date() });

  let posted = { sent: false, reason: decision.why };
  if (decision.yes) {
    posted = await postReport(report, config);
    // Only mark the day done when a mail actually went. A failed send must be
    // retried on the next pass, not silently swallowed until tomorrow.
    if (posted.sent) report.lastReported = report.today;
  }
  if (!report.lastReported && previous.ok && previous.value.lastReported) {
    report.lastReported = previous.value.lastReported;
  }

  if (!dryRun) writeJsonIfChanged(abs('data', 'checks.json'), report);

  process.stdout.write(posted.sent
    ? `${green('✓')} report mailed — ${decision.why}\n`
    : `${dim(`· no mail: ${posted.reason ?? `HTTP ${posted.status}`}`)}\n`);

  process.stdout.write(`\n${report.summary.sitesOk}/${report.summary.sites} sites`
    + `${report.summary.forms ? ` · ${report.summary.formsOk}/${report.summary.forms} forms` : ''}`
    + ` · ${failed} failing\n`);

  // Exit 0 even when sites are down: a failing check is a finding to report,
  // not a broken build. The timer must carry on to the next pass regardless.
  return 0;
}

// Same guard the other commands use: importing checkIssues from build.js must
// never fire off twenty HTTP requests and a CRM submission.
if (path.resolve(process.argv[1] ?? '') === path.resolve(ROOT, 'src', 'check.js')) {
  process.exit(await runChecks());
}
