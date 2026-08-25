/**
 * Projects are DISCOVERED from server data, not only hand-written.
 *
 * Every VPS carries its own projects and workflows, and most of them will never
 * get a Markdown doc. Deriving a project record from what is actually deployed
 * — a vhost, the systemd unit or container behind it, the directory it runs
 * from — means the estate is complete on day one, and a `content/projects/*.md`
 * file becomes an ENRICHMENT of a real thing rather than the only way it exists.
 *
 * Precedence: a documented project wins every field it declares. Derived data
 * fills the rest, and always supplies `discovered` evidence.
 */

const HOST_STOPWORDS = /^(www|mail|ftp|ns\d*)$/i;

/** Turn a hostname or unit name into a stable project id. */
export function slugFor(input) {
  return String(input ?? '')
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.(co\.in|com|org|in|mobi|cloud|net)$/, '')
    .replace(/\.hstgr$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

/** "127.0.0.1:8002" -> 8002 */
function portOf(upstream) {
  const m = /:(\d{2,5})\b/.exec(String(upstream ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Which unit or container serves this upstream port?
 * @returns {{ kind: 'service'|'container', name: string, state: string }|null}
 */
function backendFor(server, port) {
  if (port == null) return null;

  const svc = (server.services ?? []).find((s) => s.port === port);
  if (svc) return { kind: 'service', name: svc.name, state: svc.state, desc: svc.desc };

  const container = (server.containers ?? []).find((c) => new RegExp(`:${port}->`).test(c.ports ?? ''));
  if (container) return { kind: 'container', name: container.name, state: container.state, desc: container.image };

  const listening = (server.ports ?? []).find((p) => p.port === port);
  if (listening?.proc) return { kind: 'service', name: listening.proc, state: 'running' };

  return null;
}

/** A deploy directory whose name plausibly matches this project. */
function directoryFor(server, tokens) {
  const dirs = server.projects ?? [];
  let best = null;
  let bestScore = 0;
  for (const dir of dirs) {
    const base = dir.path.split('/').pop().toLowerCase();
    for (const token of tokens) {
      if (!token || token.length < 3) continue;
      const score = base === token ? 3
        : base.replace(/[^a-z0-9]/g, '').includes(token.replace(/[^a-z0-9]/g, '')) ? 2
          : token.includes(base) ? 1 : 0;
      if (score > bestScore) { bestScore = score; best = dir; }
    }
  }
  return bestScore >= 2 ? best : null;
}

/**
 * status is derived from the backend, never guessed:
 *   running        -> live
 *   failed / dead  -> broken
 *   created/exited -> idle
 *   nothing found  -> idle
 */
function statusFor(backend) {
  if (!backend) return 'idle';
  if (backend.state === 'running') return 'live';
  if (backend.state === 'failed' || backend.state === 'dead') return 'broken';
  if (backend.state === 'restarting') return 'broken';
  return 'idle';
}

/**
 * @param {Record<string, object>} servers
 * @returns {Record<string, object>} keyed by project id
 */
export function deriveProjects(servers) {
  const derived = {};

  for (const [serverId, server] of Object.entries(servers)) {
    /* one project per public hostname */
    for (const vhost of server.vhosts ?? []) {
      const host = vhost.domain.toLowerCase();
      const label = host.split('.')[0];
      if (HOST_STOPWORDS.test(label)) continue;

      // A bare `server_name` with no upstream and no docroot is a catch-all
      // block, not a project. The host's own FQDN is the usual culprit.
      if (!vhost.proxyTo && !vhost.root) continue;

      const id = slugFor(host);
      const port = portOf(vhost.proxyTo);
      const backend = backendFor(server, port);
      const dir = directoryFor(server, [label, backend?.name ?? '']);

      // A bare apex and its www twin are one project.
      const existing = derived[id];
      if (existing && existing.server === serverId) {
        existing.discovered.hostnames.push(vhost.domain);
        continue;
      }

      derived[id] = {
        id,
        name: vhost.domain,
        server: serverId,
        status: statusFor(backend),
        url: backend?.desc ?? (vhost.root ? `static · ${vhost.root}` : vhost.proxyTo ?? ''),
        href: vhost.ssl ? `https://${vhost.domain}` : `http://${vhost.domain}`,
        tags: [
          vhost.source,
          backend?.kind === 'container' ? 'docker' : backend?.kind === 'service' ? 'systemd' : null,
          port ? `:${port}` : null,
        ].filter(Boolean),
        services: backend ? [backend.name] : [],
        workflows: [],
        origin: 'derived',
        discovered: {
          hostnames: [vhost.domain],
          port,
          backend: backend?.name ?? null,
          backendState: backend?.state ?? null,
          directory: dir?.path ?? null,
          size: dir?.size ?? null,
          git: dir?.git ?? false,
          remote: dir?.remote ?? null,
          hasEnv: dir?.hasEnv ?? false,
          certExpiryDays: vhost.certExpiryDays ?? null,
          ssl: vhost.ssl ?? false,
        },
      };
    }

    /* projects with no hostname: a deploy directory with a unit behind it */
    const alreadyServed = new Set(
      Object.values(derived).filter((p) => p.server === serverId).flatMap((p) => p.services ?? []),
    );
    const alreadyRooted = new Set(
      Object.values(derived).filter((p) => p.server === serverId)
        .map((p) => p.discovered?.directory).filter(Boolean),
    );

    for (const dir of server.projects ?? []) {
      const base = dir.path.split('/').pop();
      const id = slugFor(base);
      if (derived[id]) continue;
      if (/^(html|media|containerd)$/i.test(base)) continue;
      // Already reachable through a hostname; this is the same project seen
      // from its filesystem side, not a second one.
      if (alreadyRooted.has(dir.path)) continue;

      const svc = (server.services ?? []).find((s) => {
        const n = s.name.toLowerCase();
        const b = base.toLowerCase().replace(/[^a-z0-9]/g, '');
        return n.replace(/[^a-z0-9]/g, '') === b || (s.workingDir ?? '') === dir.path;
      });
      if (!svc || alreadyServed.has(svc.name)) continue;
      alreadyServed.add(svc.name);

      derived[id] = {
        id,
        name: base,
        server: serverId,
        status: statusFor({ state: svc.state }),
        url: svc.desc ?? dir.path,
        tags: ['systemd', svc.port ? `:${svc.port}` : null].filter(Boolean),
        services: [svc.name],
        workflows: [],
        origin: 'derived',
        discovered: {
          hostnames: [],
          port: svc.port ?? null,
          backend: svc.name,
          backendState: svc.state,
          directory: dir.path,
          size: dir.size ?? null,
          git: dir.git ?? false,
          remote: dir.remote ?? null,
          hasEnv: dir.hasEnv ?? false,
          certExpiryDays: null,
          ssl: false,
        },
      };
    }

    /* containers that publish a port but sit behind no hostname. Without this
       a host like srv1870078 — an n8n box with no nginx in front of it —
       reports zero projects while plainly running one. */
    for (const container of server.containers ?? []) {
      if (alreadyServed.has(container.name)) continue;
      if (!/->/.test(container.ports ?? '')) continue;

      const id = slugFor(container.name);
      if (derived[id]) continue;

      const published = /(?:^|,\s*)([\d.]+|\[::\]):(\d{2,5})->/.exec(container.ports ?? '');
      derived[id] = {
        id,
        name: container.name,
        server: serverId,
        status: statusFor(container),
        url: container.image ?? 'container',
        tags: ['docker', published ? `:${published[2]}` : null,
          published && (published[1] === '0.0.0.0' || published[1] === '[::]') ? 'published' : null].filter(Boolean),
        services: [container.name],
        workflows: [],
        origin: 'derived',
        discovered: {
          hostnames: [],
          port: published ? Number(published[2]) : null,
          backend: container.name,
          backendState: container.state,
          directory: null,
          size: null,
          git: false,
          remote: null,
          hasEnv: false,
          certExpiryDays: null,
          ssl: false,
        },
      };
    }
  }

  return derived;
}

/**
 * Attach workflows to projects. A documented project's explicit `workflows`
 * list wins; otherwise workflows fall to the project that owns the n8n
 * instance on their server.
 */
export function attachWorkflows(projects, workflows, servers) {
  const claimed = new Set();
  for (const p of projects) for (const id of p.workflows ?? []) claimed.add(id);

  // The project that IS n8n on each server, so unclaimed workflows have a home.
  const n8nHost = {};
  for (const [serverId, server] of Object.entries(servers)) {
    if (!server.n8n?.container) continue;
    const host = projects.find((p) => p.server === serverId
      && (p.services ?? []).some((s) => s === server.n8n.container));
    if (host) n8nHost[serverId] = host;
  }

  for (const [id, wf] of Object.entries(workflows)) {
    if (claimed.has(id) || !wf.server) continue;
    const host = n8nHost[wf.server];
    if (!host) continue;
    host.workflows = host.workflows ?? [];
    host.workflows.push(id);
  }

  return projects;
}

/**
 * Merge derived projects with documented ones. Documented fields win; derived
 * evidence is always preserved under `discovered`.
 */
export function mergeProjects(documented, derived) {
  const byId = new Map();

  for (const [id, project] of Object.entries(derived)) byId.set(id, project);

  for (const doc of documented) {
    const base = byId.get(doc.id);
    if (!base) {
      byId.set(doc.id, { ...doc, origin: 'documented' });
      continue;
    }
    const merged = { ...base };
    for (const [key, value] of Object.entries(doc)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      merged[key] = value;
    }
    merged.origin = 'documented';
    merged.discovered = base.discovered;
    // union the service lists so the doc does not have to repeat what we found
    merged.services = [...new Set([...(base.services ?? []), ...(doc.services ?? [])])];
    byId.set(doc.id, merged);
  }

  return [...byId.values()];
}
