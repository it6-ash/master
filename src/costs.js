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
    line.monthly = monthly(line.amount, line.cycle ?? 'monthly');
    line.daysUntil = daysUntil(line.renewsOn, today);
  }

  // Soonest renewal first; lines with no date sink to the bottom rather than
  // sorting as 1970 and shouting for attention they have not earned.
  lines.sort((a, b) => (a.renewsOn ?? '9999').localeCompare(b.renewsOn ?? '9999') || a.label.localeCompare(b.label));

  const priced = lines.filter((l) => Number.isFinite(l.monthly));
  return {
    currency,
    note: file.ok ? file.value.note : null,
    lines,
    recorded: priced.length,
    total: lines.length,
    monthlyTotal: priced.length ? Math.round(priced.reduce((sum, l) => sum + l.monthly, 0)) : null,
  };
}
