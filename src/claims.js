/**
 * Re-test hand-written issue claims against the newest ingest.
 *
 * A written document is a snapshot of a belief. `data/servers.json` is a
 * snapshot of reality. When those disagree the dashboard should say so, rather
 * than repeating a four-day-old claim as current fact, or silently deleting a
 * finding somebody took the trouble to write down.
 *
 * Three outcomes:
 *   holds        live data still matches the claim
 *   reconciled   live data contradicts it, so it looks fixed since it was written
 *   unverifiable the data needed is absent (server never ingested, section missing)
 */

const get = (object, path) => String(path ?? '').split('.')
  .reduce((cursor, key) => (cursor == null ? cursor : cursor[key]), object);

const compare = (actual, op, expected) => {
  switch (op ?? 'eq') {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'gt': return typeof actual === 'number' && actual > expected;
    case 'lt': return typeof actual === 'number' && actual < expected;
    default: return false;
  }
};

/**
 * @returns {{ status: 'holds'|'reconciled'|'unverifiable', actual: any, detail: string }}
 */
export function testClaim(claim, servers) {
  if (!claim) return { status: 'unverifiable', actual: null, detail: 'no claim declared' };

  const server = servers?.[claim.server];
  if (!server) {
    return { status: 'unverifiable', actual: null, detail: `no data for ${claim.server}` };
  }

  switch (claim.kind) {
    case 'port-exposed': {
      if (!server.ports) return { status: 'unverifiable', actual: null, detail: 'no port data in the latest dump' };
      const entry = server.ports.find((p) => p.port === claim.port);
      const actual = entry ? entry.exposed === true : false;
      const expected = claim.expect !== undefined ? claim.expect : true;
      return {
        status: actual === expected ? 'holds' : 'reconciled',
        actual,
        detail: entry
          ? `port ${claim.port} is bound to ${entry.bind}`
          : `nothing is listening on port ${claim.port}`,
      };
    }

    case 'firewall': {
      const actual = server.state?.firewall;
      if (!actual) return { status: 'unverifiable', actual: null, detail: 'no firewall data' };
      const expected = claim.expect ?? 'inactive';
      return {
        status: actual === expected ? 'holds' : 'reconciled',
        actual,
        detail: `ufw is ${actual}`,
      };
    }

    case 'unit-state': {
      if (!server.services) return { status: 'unverifiable', actual: null, detail: 'no service data' };
      const unit = server.services.find((s) => s.name === claim.unit);
      const actual = unit?.state ?? 'absent';
      const expected = claim.expect ?? 'failed';
      return {
        status: actual === expected ? 'holds' : 'reconciled',
        actual,
        detail: `${claim.unit} is ${actual}`,
      };
    }

    case 'container-state': {
      if (!server.containers) return { status: 'unverifiable', actual: null, detail: 'no container data' };
      const container = server.containers.find((c) => c.name === claim.container);
      const actual = container?.state ?? 'absent';
      const expected = claim.expect ?? 'running';
      return {
        status: actual === expected ? 'holds' : 'reconciled',
        actual,
        detail: `${claim.container} is ${actual}`,
      };
    }

    case 'value': {
      const actual = get(server, claim.path);
      if (actual === undefined) {
        return { status: 'unverifiable', actual: null, detail: `${claim.path} is not present` };
      }
      return {
        status: compare(actual, claim.op, claim.expect) ? 'holds' : 'reconciled',
        actual,
        detail: `${claim.path} is ${JSON.stringify(actual)}`,
      };
    }

    default:
      return { status: 'unverifiable', actual: null, detail: `unknown claim kind "${claim.kind}"` };
  }
}

/**
 * Annotate every issue that carries a claim. Issues without one pass through
 * untouched — a claim is optional, and most auto issues do not need it because
 * they ARE the live reading.
 */
export function reconcileIssues(issues, servers) {
  return issues.map((issue) => {
    if (!issue.claim) return issue;
    const result = testClaim(issue.claim, servers);
    return { ...issue, claimStatus: result.status, claimDetail: result.detail, claimActual: result.actual };
  });
}
