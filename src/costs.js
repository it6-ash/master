/**
 * What the estate costs to keep running, and when each line renews.
 *
 * The *list* is derived from what the servers actually report — three VPS and
 * every registrable domain nginx answers for — so a domain that gets deployed
 * shows up here on the next collection whether or not anyone remembered to
 * record it. The *prices and dates* cannot be derived from a dump and are read
 * from data/costs.json. A line with no recorded price renders as "not
 * recorded", which is the useful answer: it names the bill you are not tracking.
 */

import { abs, readJson } from './lib/fsx.js';

/** Hostinger's KVM lineup, by vCPU count. Their hostnames are *.hstgr.cloud. */
const KVM_TIERS = { 1: 'KVM 1', 2: 'KVM 2', 4: 'KVM 4', 8: 'KVM 8', 16: 'KVM 16' };

export function planFor(specs) {
  if (!specs || specs.virt !== 'kvm') return null;
  return KVM_TIERS[specs.cpu] ?? null;
}

/**
 * "www.kwbluepearl.com" -> "kwbluepearl.com". Two-label public suffixes like
 * co.in are the reason this is not just "last two labels".
 */
const TWO_LABEL_SUFFIX = /\.(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/i;

export function registrableDomain(hostname) {
  const name = String(hostname ?? '').toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  if (!name.includes('.') || /^[\d.]+$/.test(name)) return null;
  // Provider-issued, not registered, not renewable, not yours to pay for.
  if (name.endsWith('.hstgr.cloud') || name.endsWith('.localhost')) return null;
  const parts = name.split('.');
  const keep = TWO_LABEL_SUFFIX.test(name) ? 3 : 2;
  return parts.length <= keep ? name : parts.slice(-keep).join('.');
}

const monthly = (amount, cycle) => {
  if (!Number.isFinite(amount)) return null;
  if (cycle === 'yearly') return amount / 12;
  if (cycle === 'quarterly') return amount / 3;
  return amount;
};

/**
 * The date that actually matters for this line.
 *
 * While it auto-renews that is the charge date — money leaves then, and the
 * provider bills days or weeks before expiry. Once auto-renew is off it is the
 * expiry date, because that is when the box stops, and no invoice will warn you.
 */
const nextDate = (line) => (line.autoRenew === false ? line.expiresOn : (line.chargeOn ?? line.expiresOn)) ?? null;

/** Whole days from `today` to `date`, negative once it has passed. */
export function daysUntil(date, today) {
  if (!date) return null;
  const then = Date.parse(`${date}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(then) && Number.isFinite(now) ? Math.round((then - now) / 86400000) : null;
};

/**
 * @returns {{ currency, note, lines: Array, monthlyTotal: number|null, recorded: number, total: number }}
 */
export function buildCosts(servers, { today }) {
  const file = readJson(abs('data', 'costs.json'));
  const recorded = file.ok ? (file.value.items ?? {}) : {};
  const currency = file.ok ? (file.value.currency ?? 'INR') : 'INR';

  const lines = [];
  const seenDomain = new Set();

  for (const [id, server] of Object.entries(servers)) {
    const plan = planFor(server.specs);
    lines.push({
      id: `vps:${id}`,
      kind: 'vps',
      label: id,
      detail: [plan, server.specs?.cpu && `${server.specs.cpu} vCPU`, server.specs?.ram && `${server.specs.ram} RAM`, server.specs?.disk && `${server.specs.disk} disk`]
        .filter(Boolean).join(' · '),
      server: id,
      ...recorded[`vps:${id}`],
    });

    for (const vhost of server.vhosts ?? []) {
      const domain = registrableDomain(vhost.domain);
      if (!domain || seenDomain.has(domain)) continue;
      seenDomain.add(domain);
      lines.push({
        id: `domain:${domain}`,
        kind: 'domain',
        label: domain,
        detail: `served by ${id}`,
        server: id,
        ...recorded[`domain:${domain}`],
      });
    }
  }

  // Anything hand-recorded that is not a VPS or a domain nginx answers for —
  // an API subscription, a mail plan — still belongs on the bill.
  for (const [id, item] of Object.entries(recorded)) {
    if (lines.some((l) => l.id === id)) continue;
    lines.push({ id, kind: id.split(':')[0], label: item.label ?? id.split(':').slice(1).join(':'), ...item });
  }

  for (const line of lines) {
    // Tax is not a rounding error: 18% GST on a ₹31k VPS is ₹5,613.
    line.gross = Number.isFinite(line.amount) ? line.amount + (line.tax ?? 0) : null;
    line.monthly = monthly(line.gross, line.cycle ?? 'monthly');
    line.nextDate = nextDate(line);
    line.daysUntil = daysUntil(line.nextDate, today);
  }

  // Soonest first; lines with no date sink to the bottom rather than sorting as
  // 1970 and shouting for attention they have not earned.
  lines.sort((a, b) => (a.nextDate ?? '9999').localeCompare(b.nextDate ?? '9999') || a.label.localeCompare(b.label));

  const priced = lines.filter((l) => Number.isFinite(l.monthly));
  return {
    currency,
    note: file.ok ? file.value.note : null,
    lines,
    recorded: priced.length,
    total: lines.length,
    monthlyTotal: priced.length ? Math.round(priced.reduce((sum, l) => sum + l.monthly, 0)) : null,
    annualTotal: priced.length ? Math.round(priced.reduce((sum, l) => sum + l.monthly, 0) * 12) : null,
    issues: costIssues(lines, { today }),
  };
}

/**
 * A billing fact that is really an outage on a timer.
 *
 * A cancelled subscription is the one that matters. Nothing on the server
 * reports it, no monitoring will catch it, and the first symptom is the box
 * being gone — so it belongs in Issues next to the failing units, not only in
 * a table of dates.
 */
export function costIssues(lines, { today }) {
  const issues = [];

  for (const line of lines) {
    if (line.autoRenew !== false || !line.expiresOn) continue;
    const days = daysUntil(line.expiresOn, today);
    const what = line.kind === 'vps' ? 'server' : line.kind;

    issues.push({
      id: `subscription-cancelled-${line.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      severity: days !== null && days <= 90 ? 'critical' : 'high',
      title: `${line.label}: subscription cancelled, ${what} stops on ${line.expiresOn}`,
      body: `Auto-renew is off. Hostinger will not bill again, so this ${what} shuts down on ${line.expiresOn}`
        + `${days !== null ? ` — ${days} days from the last build` : ''}. `
        + `Resuming the subscription costs ${line.gross !== null ? `₹${Math.round(line.gross).toLocaleString('en-IN')} a year` : 'the usual renewal price'}. `
        + 'Nothing running on the box reports this and no monitoring will catch it; the first symptom is the box being gone.',
      ...(line.server ? { server: line.server } : {}),
      source: 'auto',
      rule: 'subscription-cancelled',
      evidence: `data/costs.json: autoRenew false, expiresOn ${line.expiresOn}`,
      opened: today,
    });
  }

  return issues;
}
