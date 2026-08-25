/**
 * Renders the single-file dashboard.
 *
 * Server-rendered end to end: KPI row, charts, server cards, project grid,
 * workflow inventory, and every drawer panel are in the markup before a line of
 * script runs. JavaScript only opens drawers, filters, and routes the hash — so
 * the page reads and prints with scripting off, and works from file://.
 *
 * Two drawer kinds share one shell: `project:<id>` and `server:<id>`.
 */

import { renderMarkdown, escapeHtml } from './markdown.js';
import { renderFlowSvg, escapeRegExp } from './flow-svg.js';
import { parseFlow } from '../parse/flow-dsl.js';
import { funnelChart, workflowChart, costChart, sparkline, statTile } from './charts.js';

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const bySeverity = (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n ?? ''));

const EVENT_LABELS = {
  'service.failed': 'unit failed', 'service.recovered': 'unit recovered',
  'service.appeared': 'new unit', 'service.disappeared': 'unit gone',
  'port.exposed': 'port exposed', 'port.unexposed': 'port closed to public',
  'port.appeared': 'new port', 'port.closed': 'port closed',
  'container.appeared': 'new container', 'container.disappeared': 'container gone',
  'container.state': 'container state', 'disk.jump': 'disk moved',
  'disk.threshold': 'disk over 80%', 'kernel.updated': 'kernel updated',
  'reboot.pending': 'reboot pending', 'firewall.changed': 'firewall changed',
  'cert.expiring': 'cert expiring', 'cert.renewed': 'cert renewed',
  'vhost.appeared': 'new hostname', 'vhost.disappeared': 'hostname gone',
  'workflow.activated': 'workflow on', 'workflow.deactivated': 'workflow off',
  'workflow.appeared': 'new workflow', 'workflow.disappeared': 'workflow gone',
  'project.appeared': 'new directory', 'project.disappeared': 'directory gone',
  'db.growth': 'collection grew', 'server.stale': 'data stale',
};

/* ----------------------------------------------------------- search */

/**
 * A search index emitted with the page.
 *
 * The previous implementation hid non-matching cards in place, which left every
 * heading, tile and section note behind — so from the top of the page a search
 * looked like it had done nothing at all. Matching against a real index and
 * showing a real result list is both clearer and faster.
 */
function buildSearchIndex({ servers, projects, workflows, issues }) {
  const entries = [];

  for (const [id, server] of Object.entries(servers)) {
    entries.push({
      kind: 'server',
      open: `server:${id}`,
      label: id,
      sub: [server.role, server.ip].filter(Boolean).join(' · '),
      text: [id, server.role, server.ip, server.state?.os].filter(Boolean).join(' ').toLowerCase(),
    });
  }

  for (const project of projects) {
    entries.push({
      kind: 'project',
      open: `project:${project.id}`,
      label: project.name,
      sub: [project.server, project.url].filter(Boolean).join(' · '),
      text: [project.id, project.name, project.summary, project.url, project.server,
        ...(project.tags ?? []), ...(project.services ?? []),
        ...(project.discovered?.hostnames ?? []),
      ].filter(Boolean).join(' ').toLowerCase(),
    });
  }

  for (const [id, wf] of Object.entries(workflows)) {
    entries.push({
      kind: 'workflow',
      open: `workflow:${id}`,
      label: wf.name,
      sub: [wf.group, wf.server, wf.active ? 'active' : 'off'].filter(Boolean).join(' · '),
      state: wf.active ? 'live' : 'idle',
      noise: wf.noise === true,
      text: [id, wf.name, wf.group, wf.server].filter(Boolean).join(' ').toLowerCase(),
    });
  }

  for (const issue of issues) {
    if (issue.resolved) continue;
    entries.push({
      kind: 'issue',
      open: issue.project ? `project:${issue.project}` : issue.server ? `server:${issue.server}` : null,
      label: issue.title,
      sub: [issue.severity, issue.server, issue.source].filter(Boolean).join(' · '),
      state: issue.severity === 'critical' ? 'broken' : issue.severity === 'high' ? 'partial' : null,
      text: [issue.id, issue.title, issue.body, issue.server, issue.project].filter(Boolean).join(' ').toLowerCase(),
    });
  }

  return entries;
}

/* -------------------------------------------------------- orientation */

/**
 * A section heading plus one line saying what the section shows and why it is
 * worth looking at. Someone opening this for the first time should not have to
 * infer what a panel is from its contents.
 */
function section(title, note, count) {
  // Heading and explanation are one unit, so a wide viewport can set them side
  // by side instead of leaving half the row empty beside a measure-capped line.
  return `<div class="section-head">
    <h2 class="section">${escapeHtml(title)}${count ? ` <span class="count">${escapeHtml(count)}</span>` : ''}</h2>
    ${note ? `<p class="section-note">${note}</p>` : ''}
  </div>`;
}

/**
 * The lead. What this page is, what it is built from, and how fresh it is —
 * stated in the reader's terms rather than assumed.
 */
function renderIntro({ servers, projects, workflows, builtAt }) {
  const ids = Object.keys(servers);
  const collected = ids
    .map((id) => servers[id].lastIngest)
    .filter(Boolean)
    .sort()
    .pop();

  const roles = ids.map((id) => `<strong>${escapeHtml(id)}</strong> (${escapeHtml(servers[id].role ?? 'unknown role')})`);
  const activeWf = Object.values(workflows).filter((w) => w.active).length;
  const realWf = Object.values(workflows).filter((w) => !w.noise).length;

  return `<section class="intro">
    <h1 class="intro-title">Everything KW Group runs, on one page</h1>
    <p>
      This is the whole estate: ${ids.length} servers, ${projects.length} projects and
      ${Object.keys(workflows).length} n8n workflows, of which ${realWf} are real and
      ${activeWf} are switched on. The servers are
      ${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}.
    </p>
    <p>
      Nothing here is typed by hand except the project write-ups. Everything else is
      read out of diagnostic dumps taken off the servers themselves, so a number on
      this page is a number that was true on the machine when it was collected.
      Last collection: <strong>${escapeHtml(collected?.slice(0, 10) ?? 'never')}</strong>.
    </p>
    <p class="intro-how">
      <strong>How to read it.</strong> Anything with a coloured dot has a state:
      green is running, amber is partial, red is broken, grey is idle.
      Anything underlined explains itself when you hover it. Click any server,
      project or workflow to open its own page, and the address bar will hold a
      link you can send to someone.
    </p>
  </section>`;
}

/* ------------------------------------------------------------ KPI row */

function renderTiles({ servers, projects, workflows, issues, history }) {
  const open = issues.filter((i) => !i.resolved && i.claimStatus !== 'reconciled');
  const critical = open.filter((i) => i.severity === 'critical').length;
  const activeWf = Object.values(workflows).filter((w) => w.active).length;
  const realWf = Object.values(workflows).filter((w) => !w.noise).length;
  const failed = Object.values(servers)
    .flatMap((s) => (s.services ?? []).filter((x) => x.state === 'failed')).length;
  const live = projects.filter((p) => p.status === 'live').length;
  const reconciled = issues.filter((i) => i.claimStatus === 'reconciled').length;

  const diskSeries = Object.keys(servers).map((id) => history[id]?.disk ?? []).find((d) => d.length > 1);

  return `<div class="tiles">
    ${statTile({ value: Object.keys(servers).length, label: 'Servers', note: `${Object.values(servers).filter((s) => s.state?.firewall === 'active').length} with ufw active`, spark: diskSeries ? sparkline(diskSeries) : null })}
    ${statTile({ value: projects.length, label: 'Projects', note: `${live} live · ${projects.filter((p) => p.origin === 'documented').length} documented` })}
    ${statTile({ value: `${activeWf}`, label: 'Active workflows', note: `of ${realWf} real, ${Object.keys(workflows).length} total` })}
    ${statTile({ value: critical, label: 'Critical issues', note: `${open.length} open in total`, state: critical > 0 ? 'critical' : 'good' })}
    ${statTile({ value: failed, label: 'Failed units', note: failed ? 'across the estate' : 'all units healthy', state: failed > 0 ? 'warning' : 'good' })}
    ${statTile({ value: reconciled, label: 'Claims reconciled', note: 'fixed since they were written', state: reconciled > 0 ? 'good' : null })}
  </div>`;
}

/* -------------------------------------------------------- what changed */

function renderChanges(events) {
  if (events.length === 0) {
    return `<div class="changes"><div class="empty">
      <strong>No changes yet.</strong> Every server has exactly one snapshot, so there is nothing to compare against.
      Run <code>kw-collect.sh</code> again in a few days and this panel fills itself in.
    </div></div>`;
  }
  const shown = events.slice(0, 20);
  // Closed by default. Twenty rows of "hostname gone" is a wall between the
  // reader and the servers below it, and the count in the summary is the part
  // most visits actually need. <details> does it with no script.
  return `<details class="changes-wrap">
    <summary>${shown.length}${events.length > shown.length ? ` of ${events.length}` : ''} change${shown.length === 1 ? '' : 's'} since the previous collection${shown.length ? ' — open to read them' : ''}</summary>
    <div class="changes">${shown.map((e) => {
    const subject = e.name ?? e.domain ?? (e.port != null ? `port ${e.port}` : '');
    const delta = e.from != null && e.to != null
      ? `<span class="faint">${escapeHtml(String(e.from))} → ${escapeHtml(String(e.to))}</span>`
      : e.days != null ? `<span class="faint">${e.days} days</span>` : '';
    return `<div class="change change--${e.severity ?? 'info'}">
      <div class="change-bar"></div>
      <div class="change-type">${escapeHtml(EVENT_LABELS[e.type] ?? e.type)}</div>
      <div class="change-what"><strong>${escapeHtml(String(subject))}</strong> ${delta}
        ${e.server ? `<span class="faint">on ${escapeHtml(e.server)}</span>` : ''}</div>
      <div class="change-when num">${escapeHtml(e.at ?? '')}</div>
    </div>`;
  }).join('')}</div>
  </details>`;
}

/* ------------------------------------------------------- server cards */

/** "Ubuntu 24.04.4 LTS" -> "Ubuntu 24.04". The patch level is on the detail page. */
function shortOs(os) {
  if (!os) return '';
  const m = /^(\w+)\s+(\d+\.\d+)/.exec(os);
  return m ? `${m[1]} ${m[2]}` : os.slice(0, 18);
}

/**
 * Certificate renewal, summarised.
 *
 * A card cannot list a dozen expiry dates without becoming a table, and the
 * only one that matters is the soonest — that is the date something breaks.
 * The rest are a count, and the full list is one click away on the detail page.
 */
function certSummary(server) {
  const certs = (server.vhosts ?? [])
    .filter((v) => Number.isInteger(v.certExpiryDays))
    .sort((a, b) => a.certExpiryDays - b.certExpiryDays);
  if (!certs.length) return '';

  const soonest = certs[0];
  // certbot issues one certificate for several names, so count certificates,
  // not hostnames, or a three-name cert reads as three renewals.
  const distinct = new Set(certs.map((c) => c.certName ?? c.domain)).size;
  const tone = soonest.certExpiryDays < 30 ? 'warn' : '';

  const renews = new Date(Date.now() + soonest.certExpiryDays * 86400000)
    .toISOString().slice(0, 10);

  return `<span class="cert-next${tone ? ' cert-next--warn' : ''}">
      next renewal ${soonest.certExpiryDays}d
    </span>
    <span class="cert-detail">${escapeHtml(soonest.certName ?? soonest.domain)} · ${escapeHtml(renews)}</span>
    ${distinct > 1 ? `<span class="cert-detail">+${distinct - 1} more certificate${distinct === 2 ? '' : 's'}</span>` : ''}`;
}

function renderServerCard(id, server, { issues, history, staleDays, projects, workflows }) {
  const state = server.state ?? {};
  const failed = (server.services ?? []).filter((s) => s.state === 'failed');
  const running = (server.services ?? []).filter((s) => s.state === 'running');
  const mine = projects.filter((p) => p.server === id);
  const wf = Object.values(workflows).filter((w) => w.server === id);
  const containers = server.containers ?? [];

  const alerts = issues.filter((i) => i.server === id && !i.resolved && i.claimStatus !== 'reconciled')
    .sort(bySeverity);
  const critical = alerts.filter((i) => i.severity === 'critical').length;

  const health = critical ? 'critical' : (failed.length || alerts.length) ? 'warning' : 'ok';

  /* --- meters ------------------------------------------------------- */
  // A 5% fill on a low-contrast track is invisible, so the number carries the
  // value and the bar only supports it. The bar is never the only encoding.
  const meter = (label, pct, detail) => {
    if (!Number.isInteger(pct)) return '';
    const tone = pct >= 90 ? 'bad' : pct >= 80 ? 'warn' : '';
    return `<div class="meter-row">
      <span class="meter-label">${escapeHtml(label)}</span>
      <span class="meter"><span class="meter-fill ${tone ? `meter-fill--${tone}` : ''}" style="width:${Math.max(pct, 1.5)}%"></span></span>
      <span class="meter-value"><strong>${pct}%</strong> ${escapeHtml(detail)}</span>
    </div>`;
  };

  /* --- what actually runs here -------------------------------------- */
  // Two of the three cards used to end in dead space. Showing the three biggest
  // things on the box fills it with something worth reading, and makes the
  // cards comparable rather than one dense and two hollow.
  const notable = [];
  if (server.n8n?.container) {
    notable.push({
      name: server.n8n.container,
      meta: `${wf.filter((w) => w.active).length} of ${wf.length} workflows active`,
      state: 'live',
    });
  }
  for (const [dbName, db] of Object.entries(server.databases ?? {})) {
    if (!db.collections?.length) continue;
    notable.push({
      name: dbName,
      meta: `${db.collections.length} collections · ${fmt(db.collections.reduce((a, c) => a + (c.docs ?? 0), 0))} documents`,
      state: 'live',
    });
    break;
  }
  // Anything unhealthy jumps the queue: a restarting container is more worth
  // a line than a project that is quietly fine.
  for (const c of containers.filter((x) => x.state !== 'running')) {
    if (notable.length >= 4) break;
    notable.push({ name: c.name, meta: `container ${c.state}`, state: c.state === 'restarting' ? 'broken' : 'idle' });
  }
  for (const p of mine.filter((x) => x.status === 'live' && x.discovered?.port)) {
    if (notable.length >= 4) break;
    if (notable.some((n) => n.name === p.name || n.name === p.discovered?.backend)) continue;
    notable.push({ name: p.name, meta: `port ${p.discovered.port}`, state: 'live' });
  }
  // Fill from running containers so a quiet box still says what it is doing,
  // rather than ending in dead space beside a busier neighbour.
  for (const c of containers.filter((x) => x.state === 'running')) {
    if (notable.length >= 4) break;
    if (notable.some((n) => n.name === c.name)) continue;
    notable.push({ name: c.name, meta: escapeHtml(c.image ?? 'container'), state: 'live' });
  }
  const SYSTEM_DIR = /\/(containerd|html|lost\+found|media)$/;
  for (const dir of (server.projects ?? []).filter((d) => d.sizeBytes && !SYSTEM_DIR.test(d.path))) {
    if (notable.length >= 4) break;
    const base = dir.path.split('/').pop();
    if (notable.some((n) => n.name === base)) continue;
    notable.push({ name: base, meta: `${dir.size} on disk`, state: 'idle' });
  }

  /* --- counts strip -------------------------------------------------- */
  const counts = [
    [mine.length, 'projects'],
    [wf.length, 'workflows'],
    [containers.length, 'containers'],
    [running.length, 'units up'],
  ].filter(([n]) => n > 0);

  return `<button class="server searchable tilt server--${health}" type="button" data-open="server:${escapeHtml(id)}"
      data-search="${escapeHtml(`${id} ${server.role ?? ''} ${server.ip ?? ''}`.toLowerCase())}">
    <div class="server-head">
      <div>
        <div class="server-name">${escapeHtml(id)}</div>
        <div class="server-role">${escapeHtml(server.role ?? '')}</div>
      </div>
      <div class="server-meta">
        <div class="server-ip">${escapeHtml(server.ip ?? '')}</div>
        ${staleDays != null && staleDays > 7
    ? `<div class="stale">collected ${staleDays}d ago</div>`
    : `<div class="faint">collected ${escapeHtml(server.lastIngest?.slice(0, 10) ?? 'never')}</div>`}
      </div>
    </div>

    <div class="server-spec">
      ${server.specs?.cpu ? `<span>${server.specs.cpu} vCPU</span>` : ''}
      ${server.specs?.ram ? `<span>${escapeHtml(server.specs.ram)} RAM</span>` : ''}
      ${server.specs?.disk ? `<span>${escapeHtml(server.specs.disk)} disk</span>` : ''}
      ${server.specs?.virt ? `<span title="Virtualisation">${escapeHtml(server.specs.virt)}</span>` : ''}
      ${shortOs(state.os) ? `<span>${escapeHtml(shortOs(state.os))}</span>` : ''}
      ${state.uptime ? `<span>up ${escapeHtml(state.uptime)}</span>` : ''}
    </div>

    ${certSummary(server) ? `<div class="cert-line">${certSummary(server)}</div>` : ''}

    <div class="meters">
      ${meter('disk', state.diskUsedPct, `${state.diskUsed ?? ''} of ${state.diskTotal ?? ''}`)}
      ${meter('memory', state.memUsedPct, `${state.memUsed ?? ''} of ${state.memTotal ?? ''}`)}
    </div>

    ${counts.length ? `<div class="server-counts">${counts.map(([n, label]) => `<span class="count-cell">
      <strong>${n}</strong><span>${escapeHtml(label)}</span>
    </span>`).join('')}</div>` : ''}

    ${notable.length ? `<div class="runs-here">
      <div class="runs-title">What runs here</div>
      ${notable.slice(0, 4).map((n) => `<div class="runs-row">
        <span class="dot dot--${n.state}"></span>
        <span class="runs-name">${escapeHtml(n.name)}</span>
        <span class="runs-meta">${escapeHtml(n.meta)}</span>
      </div>`).join('')}
    </div>` : ''}

    <div class="server-foot">
      <span class="pill${state.firewall === 'active' ? '' : ' pill--bad'}">
        <span class="dot dot--${state.firewall === 'active' ? 'live' : 'broken'}"></span>ufw ${escapeHtml(state.firewall ?? '?')}</span>
      ${failed.length ? `<span class="pill pill--bad"><span class="dot dot--broken"></span>${failed.length} failed</span>` : ''}
      ${state.rebootPending ? '<span class="pill">reboot pending</span>' : ''}
      ${alerts.length
    ? `<span class="pill${critical ? ' pill--bad' : ''}">${alerts.length} open issue${alerts.length === 1 ? '' : 's'}${critical ? `, ${critical} critical` : ''}</span>`
    : '<span class="pill"><span class="dot dot--live"></span>no open issues</span>'}
    </div>

    ${alerts.length ? `<div class="server-alerts">${alerts.slice(0, 2).map((i) => `<div class="server-alert">
      <span class="sev sev--${i.severity}">${i.severity}</span><span>${escapeHtml(i.title)}</span>
    </div>`).join('')}${alerts.length > 2 ? `<div class="server-alert faint">and ${alerts.length - 2} more</div>` : ''}</div>` : ''}
  </button>`;
}

/* ------------------------------------------------------ server drawer */

/**
 * A server's topology, derived from its own record rather than drawn by hand:
 * the internet, the proxies that actually own 80/443, and every backend a
 * hostname resolves to. No edge here is invented — each one comes from a vhost
 * whose upstream port matched a running unit or container.
 */
function serverTopology(server, id) {
  const nodes = [];
  const edges = [];
  const seen = new Set();

  const add = (node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    nodes.push({ sublabel: null, state: null, x: null, y: null, line: 0, ...node });
    return true;
  };
  const key = (s) => String(s).replace(/[^A-Za-z0-9]/g, '_').replace(/^(\d)/, 'n$1');

  add({ id: 'net', kind: 'ext', label: 'Internet', sublabel: server.ip ?? id });

  const sources = new Set((server.vhosts ?? []).map((v) => v.source));
  if (sources.has('nginx')) {
    const nginx = (server.services ?? []).find((x) => x.name === 'nginx');
    add({ id: 'nginx', kind: 'node', label: 'nginx', sublabel: ':80 :443', state: nginx?.state === 'running' ? 'live' : 'broken' });
    edges.push({ from: 'net', to: 'nginx', state: 'live', label: null, line: 0 });
  }
  if (sources.has('cloudflared')) {
    const cf = (server.services ?? []).find((x) => x.name === 'cloudflared');
    add({ id: 'tunnel', kind: 'node', label: 'cloudflared', sublabel: 'tunnel', state: cf?.state === 'running' ? 'live' : 'broken' });
    edges.push({ from: 'net', to: 'tunnel', state: 'live', label: null, line: 0 });
  }

  for (const v of server.vhosts ?? []) {
    const port = /:(\d{2,5})\b/.exec(v.proxyTo ?? '');
    const svc = port ? (server.services ?? []).find((x) => x.port === Number(port[1])) : null;
    const container = port ? (server.containers ?? []).find((c) => new RegExp(`:${port[1]}->`).test(c.ports ?? '')) : null;
    const backend = svc?.name ?? container?.name ?? (v.root ? 'static' : null);
    if (!backend) continue;

    const nodeId = key(backend);
    const runState = svc?.state ?? container?.state;
    const nodeState = runState === 'running' ? 'live'
      : (runState === 'failed' || runState === 'restarting') ? 'broken' : 'idle';
    add({
      id: nodeId,
      kind: 'node',
      label: backend.length > 20 ? `${backend.slice(0, 19)}…` : backend,
      sublabel: port ? `:${port[1]}` : v.root,
      state: nodeState,
    });

    const proxy = v.source === 'cloudflared' ? 'tunnel' : 'nginx';
    if (seen.has(proxy) && !edges.some((e) => e.from === proxy && e.to === nodeId)) {
      edges.push({ from: proxy, to: nodeId, state: nodeState === 'broken' ? 'broken' : 'data', label: null, line: 0 });
    }
  }

  if (nodes.length < 2) return null;
  return { nodes, edges, errors: [], warnings: [] };
}


/** Compact issue row: severity, title, and the detail behind a disclosure. */
function renderIssueCompact(issue) {
  const reconciled = issue.claimStatus === 'reconciled';
  const claim = issue.claimStatus ? `<div class="claim-note claim-note--${issue.claimStatus}">
    ${reconciled
    ? `Re-tested: <strong>no longer reproduces</strong>. ${escapeHtml(issue.claimDetail ?? '')}.`
    : issue.claimStatus === 'holds'
      ? `Re-tested: <strong>still true</strong>. ${escapeHtml(issue.claimDetail ?? '')}.`
      : `Could not re-test: ${escapeHtml(issue.claimDetail ?? '')}.`}
  </div>` : '';

  return `<details class="issue-row issue--${issue.severity}${reconciled ? ' reconciled' : ''}">
    <summary>
      <span class="sev sev--${issue.severity}">${issue.severity}</span>
      <span class="issue-title">${escapeHtml(issue.title)}</span>
      ${issue.project ? `<span class="issue-link">${linkProject(issue.project)}</span>` : ''}
      <span class="faint issue-src">${escapeHtml(issue.source)}</span>
    </summary>
    <div class="issue-detail">
      <div class="issue-body">${escapeHtml(issue.body ?? '')}</div>
      ${issue.evidence ? `<div class="issue-evidence">${escapeHtml(issue.evidence)}</div>` : ''}
      ${claim}
    </div>
  </details>`;
}

function renderServerPanel(id, server, { projects, workflows, issues, glossary = {} }) {
  const state = server.state ?? {};
  const mine = projects.filter((p) => p.server === id);
  const wf = Object.entries(workflows).map(([wid, w]) => ({ id: wid, ...w })).filter((w) => w.server === id);
  const failed = (server.services ?? []).filter((x) => x.state === 'failed');
  const running = (server.services ?? []).filter((x) => x.state === 'running');
  const exposed = (server.ports ?? []).filter((p) => p.exposed);
  const mineIssues = issues.filter((i) => i.server === id && !i.resolved).sort(bySeverity);

  const table = (headers, rows) => (rows.length ? `<div class="table-wrap"><table>
    <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td data-label="${escapeHtml(headers[i] ?? '')}">${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>` : '<p class="faint">Nothing recorded.</p>');

  let n = 0;
  const panel = (title, html, mod = '') => {
    if (!html) return '';
    n += 1;
    return `<section class="board-panel${mod}">
      <h2 class="board-title"><span class="board-num">${n}</span>${escapeHtml(title)}</h2>
      <div class="board-content">${html}</div>
    </section>`;
  };

  const topo = serverTopology(server, id);
  // A node that maps to a project becomes a link, so the diagram is a map you
  // can travel rather than a picture of one.
  const topoLinks = {};
  for (const node of topo?.nodes ?? []) {
    const backing = (server.services ?? []).concat(server.containers ?? [])
      .map((x) => x.name)
      .find((name) => name.replace(/[^A-Za-z0-9]/g, '_') === node.id);
    const owner = projectForService(backing, id, projects);
    if (owner) topoLinks[node.id] = { href: `#project=${owner.id}`, open: `project:${owner.id}` };
  }
  const topoHtml = topo
    ? `<div class="flow-wrap"><div class="flow-scroll">${
      renderFlowSvg(topo, { id: `t-${id}`, title: `${id} topology`, links: topoLinks, glossary })
    }${renderFlowSvg(topo, { id: `tv-${id}`, title: `${id} topology`, vertical: true, links: topoLinks, glossary })}</div></div>`
    : '';

  const meterClass = (p) => (p >= 90 ? 'meter-fill--bad' : p >= 80 ? 'meter-fill--warn' : '');

  const kpis = `<div class="tiles">
    ${statTile({ value: `${state.diskUsedPct ?? '?'}%`, label: 'Disk used', note: `${state.diskUsed ?? '?'} of ${state.diskTotal ?? '?'}`, state: (state.diskUsedPct ?? 0) > 80 ? 'critical' : null })}
    ${statTile({ value: `${state.memUsedPct ?? '?'}%`, label: 'Memory', note: `${state.memUsed ?? '?'} of ${state.memTotal ?? '?'}` })}
    ${statTile({ value: running.length, label: 'Units running', note: `${failed.length} failed`, state: failed.length ? 'warning' : 'good' })}
    ${statTile({ value: (server.containers ?? []).length, label: 'Containers', note: `${(server.containers ?? []).filter((c) => c.state === 'running').length} running` })}
    ${statTile({ value: mine.length, label: 'Projects', note: `${mine.filter((p) => p.status === 'live').length} live` })}
    ${statTile({ value: wf.length ? wf.filter((w) => w.active).length : '0', label: 'Active workflows', note: wf.length ? `of ${wf.length}` : 'no n8n here' })}
  </div>`;

  const identity = `<dl class="kv">
    <dt>Address</dt><dd>${escapeHtml(server.ip ?? 'unknown')}</dd>
    <dt>Role</dt><dd>${escapeHtml(server.role ?? '')}</dd>
    <dt>OS</dt><dd>${escapeHtml(state.os ?? '')}</dd>
    <dt>Kernel</dt><dd>${escapeHtml(state.kernel ?? '')}${state.rebootPending ? ' · reboot pending' : ''}</dd>
    <dt>CPU</dt><dd>${server.specs?.cpu ?? '?'} vCPU · ${escapeHtml(server.specs?.cpuModel ?? '')}</dd>
    <dt>Memory</dt><dd>${escapeHtml(server.specs?.ram ?? '')}</dd>
    <dt>Disk</dt><dd>${escapeHtml(server.specs?.disk ?? '')}</dd>
    <dt>Uptime</dt><dd>${escapeHtml(state.uptime ?? '')}</dd>
    <dt>Firewall</dt><dd>${escapeHtml(state.firewall ?? 'unknown')} · ${escapeHtml(state.firewallDefault ?? '')}</dd>
    <dt>Ingested</dt><dd>${escapeHtml(server.lastIngest ?? 'never')}</dd>
  </dl>`;

  const mounts = (state.mounts ?? []).map((m) => `<div class="meter-row">
    <span class="meter-label"><code>${escapeHtml(m.mount)}</code></span>
    <span class="meter"><span class="meter-fill ${meterClass(m.usePct ?? 0)}" style="width:${m.usePct ?? 0}%"></span></span>
    <span class="meter-value">${m.usePct ?? '?'}% · ${escapeHtml(m.used ?? '')}</span>
  </div>`).join('');

  const bigFiles = (server.storage?.bigFiles ?? []).slice(0, 8);
  const storageHtml = `${mounts ? `<div class="meters">${mounts}</div>` : ''}
    ${bigFiles.length ? `<h3>Largest files</h3>${table(['Path', 'Size'], bigFiles.map((f) => [
    `<code>${escapeHtml(f.path)}</code>`, `<span class="num">${escapeHtml(f.size ?? '')}</span>`,
  ]))}` : ''}`;

  const logs = server.logs ?? {};
  const logsHtml = (logs.journalSize || logs.largest?.length) ? `<dl class="kv">
      ${logs.journalSize ? `<dt>Journal</dt><dd>${escapeHtml(logs.journalSize)}</dd>` : ''}
      ${logs.varLogTotal ? `<dt>/var/log</dt><dd>${escapeHtml(logs.varLogTotal)}</dd>` : ''}
      ${logs.recentErrors ? `<dt>Recent errors</dt><dd>${logs.recentErrors} lines</dd>` : ''}
    </dl>
    ${table(['Log', 'Size'], (logs.largest ?? []).slice(0, 8).map((l) => [
    `<code>${escapeHtml(l.path)}</code>`, `<span class="num">${escapeHtml(l.size ?? '')}</span>`,
  ]))}` : '';

  const dockerHtml = server.docker ? `<dl class="kv">
      <dt>Version</dt><dd>${escapeHtml(server.docker.version ?? '')}</dd>
      <dt>Images</dt><dd>${server.docker.images ?? '?'} · ${escapeHtml(server.docker.diskUsage?.images ?? '')}</dd>
      <dt>Volumes</dt><dd>${server.docker.volumes ?? '?'} · ${escapeHtml(server.docker.diskUsage?.volumes ?? '')}</dd>
      <dt>Reclaimable</dt><dd>${escapeHtml(server.docker.diskUsage?.reclaimable ?? '')}</dd>
      ${server.docker.orphanVolumes?.length ? `<dt>Orphan volumes</dt><dd>${server.docker.orphanVolumes.map(escapeHtml).join(', ')}</dd>` : ''}
    </dl>
    ${server.docker.compose?.length ? `<h3>Compose stacks</h3>${table(['Stack', 'Status', 'File'], server.docker.compose.map((c) => [
    escapeHtml(c.name),
    `<span class="dot dot--${/^running/.test(c.status ?? '') ? 'live' : 'broken'}"></span> ${escapeHtml(c.status ?? '')}`,
    `<code>${escapeHtml(c.configFile ?? '')}</code>`,
  ]))}` : ''}` : '';

  const dbHtml = Object.keys(server.databases ?? {}).length ? `${table(['Database', 'Engine', 'Collection', 'Documents'],
    Object.entries(server.databases).flatMap(([name, db]) => (db.collections?.length
      ? db.collections.map((c) => [escapeHtml(name), escapeHtml(db.engine ?? ''), `<code>${escapeHtml(c.name)}</code>`, `<span class="num">${fmt(c.docs ?? 0)}</span>`])
      : [[escapeHtml(name), escapeHtml(db.engine ?? ''), '<span class="faint">not enumerated</span>', '—']])))}
  ${server.databaseEngines ? `<h3>Engines on this host</h3><div class="chip-list">${Object.entries(server.databaseEngines).map(([k, v]) => `<span class="pill"><span class="dot dot--${v === 'active' ? 'live' : 'idle'}"></span>${escapeHtml(k)} ${escapeHtml(v)}</span>`).join('')}</div>` : ''}` : '';

  const sshHtml = server.ssh ? `<dl class="kv">
    <dt>Port</dt><dd>${server.ssh.port ?? '?'}</dd>
    <dt>Root login</dt><dd>${server.ssh.permitRootLogin ? 'permitted' : 'denied'}</dd>
    <dt>Password auth</dt><dd>${server.ssh.passwordAuthentication ? 'enabled' : 'disabled'}</dd>
    <dt>Failed passwords</dt><dd>${server.ssh.failedPasswords ?? 0} in the current log</dd>
  </dl>
  ${server.ssh.topAttackers?.length ? `<h3>Most persistent sources</h3>${table(['Address', 'Attempts'], server.ssh.topAttackers.slice(0, 6).map((a) => [
    `<code>${escapeHtml(a.ip)}</code>`, `<span class="num">${a.count}</span>`,
  ]))}` : ''}` : '';

  const workflowHtml = wf.length ? `${table(['Workflow', 'State', 'Group'], wf
    .filter((w) => !w.noise)
    .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name))
    .map((w) => [
      escapeHtml(w.name),
      `<span class="dot dot--${w.active ? 'live' : 'idle'}"></span> ${w.active ? 'active' : 'off'}`,
      escapeHtml(w.group ?? ''),
    ]))}<p class="faint">${wf.filter((w) => w.noise).length} template imports hidden.</p>` : '';

  return `<section class="drawer-panel" data-panel="server:${escapeHtml(id)}">
    <p class="section-note">
      One of the three Hostinger VPS behind KW Group. Its job is
      <strong>${escapeHtml(server.role ?? 'not recorded')}</strong>, it answers on
      <code>${escapeHtml(server.ip ?? 'an unknown address')}</code>, and everything below was read
      out of a diagnostic dump taken on ${escapeHtml(server.lastIngest?.slice(0, 10) ?? 'an unknown date')}.
      It carries ${mine.length} project${mine.length === 1 ? '' : 's'}${wf.length ? ` and ${wf.length} n8n workflows` : ' and no n8n instance'}.
    </p>
    ${kpis}

    <div class="board">
      ${panel('Topology', topoHtml, ' board-panel--flow')}
      ${panel(`Issues · ${mineIssues.filter((i) => i.claimStatus !== 'reconciled').length} open`,
    mineIssues.length ? `<div class="issue-scroll">${mineIssues.map(renderIssueCompact).join('')}</div>` : '',
    ' board-panel--wide')}
      ${panel('Identity', identity)}
      ${panel('Storage', storageHtml, ' board-panel--wide')}

      ${panel('Projects', table(['Project', 'Status', 'Backend', 'Port'], mine.map((p) => [
    `<a href="#project=${escapeHtml(p.id)}" data-open="project:${escapeHtml(p.id)}">${escapeHtml(p.name)}</a>`,
    `<span class="dot dot--${p.status}"></span> ${escapeHtml(p.status)}`,
    escapeHtml((p.services ?? []).join(', ') || '—'),
    p.discovered?.port ? `<span class="num">${p.discovered.port}</span>` : '—',
  ])), ' board-panel--wide')}

      ${panel('Hostnames', table(['Domain', 'Upstream', 'Via', 'Cert'], (server.vhosts ?? []).map((v) => [
    (() => {
      const owner = mine.find((pr) => (pr.discovered?.hostnames ?? []).some((h) => h.toLowerCase() === v.domain.toLowerCase()));
      return owner ? linkProject(owner.id, v.domain) : escapeHtml(v.domain);
    })(),
    v.proxyTo ? `<code>${escapeHtml(v.proxyTo)}</code>` : v.root ? `static ${escapeHtml(v.root)}` : '—',
    escapeHtml(v.source ?? ''),
    v.certExpiryDays != null
      ? `<span class="num" style="color:${v.certExpiryDays < 30 ? 'var(--warning)' : 'inherit'}">${v.certExpiryDays}d</span>`
      : '<span class="faint">none</span>',
  ])), ' board-panel--wide')}

      ${panel('Exposed ports', table(['Port', 'Bind', 'Process', 'Project'], exposed.map((p) => [
    `<span class="num">${p.port}/${escapeHtml(p.proto ?? 'tcp')}</span>`,
    `<code>${escapeHtml(p.bind ?? '')}</code>`,
    escapeHtml(p.proc ?? '—'),
    (() => {
      const owner = mine.find((pr) => pr.discovered?.port === p.port);
      return owner ? linkProject(owner.id, owner.name) : '<span class="faint">—</span>';
    })(),
  ])), ' board-panel--wide')}

      ${panel('Failed units', failed.length ? table(['Unit', 'Description', 'Port', 'Project'], failed.map((x) => [
    `<code>${escapeHtml(x.name)}</code>`, escapeHtml(x.desc ?? ''), x.port ? `<span class="num">${x.port}</span>` : '—',
    (() => {
      const owner = projectForService(x.name, id, projects);
      return owner ? linkProject(owner.id, owner.name) : '<span class="faint">—</span>';
    })(),
  ])) : '<p class="faint">Every unit is healthy.</p>', ' board-panel--wide')}

      ${panel('Containers', table(['Name', 'State', 'Image', 'Age'], (server.containers ?? []).map((c) => [
    (() => {
      const owner = projectForService(c.name, id, projects);
      return owner ? linkProject(owner.id, c.name) : escapeHtml(c.name);
    })(),
    `<span class="dot dot--${c.state === 'running' ? 'live' : c.state === 'restarting' ? 'broken' : 'idle'}"></span> ${escapeHtml(c.state)}`,
    `<code>${escapeHtml(c.image ?? '')}</code>`,
    c.ageDays != null ? `<span class="num">${c.ageDays}d</span>` : '—',
  ])), ' board-panel--wide')}

      ${panel('Docker', dockerHtml, ' board-panel--wide')}
      ${panel('Databases', dbHtml, ' board-panel--wide')}
      ${panel('Workflows', workflowHtml, ' board-panel--wide')}

      ${panel('Scheduled jobs', table(['When', 'User', 'Command'], (server.cron ?? []).slice(0, 30).map((c) => [
    `<code>${escapeHtml(c.schedule ?? '')}</code>`,
    escapeHtml(c.user ?? '—'),
    `${c.hasSecret ? '<span class="sev sev--high">secret</span> ' : ''}<code>${escapeHtml((c.cmd ?? '').slice(0, 80))}</code>`,
  ])), ' board-panel--wide')}

      ${panel('Logs', logsHtml, ' board-panel--wide')}
      ${panel('SSH', sshHtml, ' board-panel--wide')}

      ${panel('Packages', server.packages ? `<dl class="kv">
        <dt>Upgradable</dt><dd>${server.packages.upgradable ?? '?'}</dd>
        <dt>apt cache</dt><dd>${escapeHtml(server.packages.aptCache ?? '')}</dd>
        ${state.kernelInstalled?.length ? `<dt>Kernels</dt><dd>${state.kernelInstalled.map(escapeHtml).join('<br>')}</dd>` : ''}
      </dl>` : '')}

      ${panel('Left lying around', server.staleFiles?.length
    ? `<ul>${server.staleFiles.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join('')}</ul>`
    : '')}
    </div>
  </section>`;
}

/**
 * A one-word note for a project that is really a platform, so the grid does
 * not present n8n as just another app.
 */
function platformNote(project, { servers, workflows }) {
  const server = project.server ? servers[project.server] : null;
  if (!server) return null;
  const own = new Set([project.discovered?.backend, ...(project.services ?? [])].filter(Boolean));

  if (server.n8n?.container && own.has(server.n8n.container)) {
    const n = Object.values(workflows).filter((w) => w.server === project.server).length;
    return `hosts ${n} workflows`;
  }
  if (own.has('nginx')) return `answers for ${(server.vhosts ?? []).length} hostnames`;
  if (own.has('mongod')) {
    const colls = Object.values(server.databases ?? {}).reduce((a, db) => a + (db.collections?.length ?? 0), 0);
    return colls ? `holds ${colls} collections` : null;
  }
  return null;
}

/* ------------------------------------------------------ project cards */

function renderProjectCard(project, { servers = {}, workflows = {} } = {}) {
  const stats = (project.stats ?? []).slice(0, 3).map((s) => `<div>
    <div class="stat-value${s.state ? ` stat-value--${s.state}` : ''}">${escapeHtml(String(s.value))}</div>
    <div class="stat-label">${escapeHtml(s.label)}</div>
  </div>`).join('');

  const search = [project.id, project.name, project.summary, project.url, project.server,
    ...(project.tags ?? []), ...(project.services ?? [])].filter(Boolean).join(' ').toLowerCase();

  return `<button class="project searchable tilt" type="button" data-open="project:${escapeHtml(project.id)}"
      data-server="${escapeHtml(project.server ?? '')}" data-status="${escapeHtml(project.status)}"
      data-search="${escapeHtml(search)}">
    <div class="project-head">
      <span class="dot dot--${project.status}"></span>
      <span class="project-name">${escapeHtml(project.name)}</span>
      <span class="project-server">${escapeHtml(project.server ?? '')}</span>
    </div>
    ${project.url ? `<div class="project-sub">${escapeHtml(project.url)}</div>` : ''}
    ${project.summary ? `<div class="project-summary">${escapeHtml(project.summary.slice(0, 120))}${project.summary.length > 120 ? '…' : ''}</div>` : ''}
    ${stats ? `<div class="stats">${stats}</div>` : ''}
    <div class="tags">
      ${(() => { const note = platformNote(project, { servers, workflows }); return note ? `<span class="platform-flag">${escapeHtml(note)}</span>` : ''; })()}
      ${project.origin === 'documented' ? '<span class="doc-flag">documented</span>' : ''}
      ${(project.tags ?? []).slice(0, 4).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
    </div>
  </button>`;
}

/**
 * What a platform hosts. Some projects are not applications but the things
 * applications run inside: n8n holds workflows, mongod holds collections,
 * nginx answers for hostnames. A page for one of those is close to useless
 * without an inventory of its tenants.
 */
function hostedBy(project, { servers, workflows, allProjects }) {
  const server = project.server ? servers[project.server] : null;
  if (!server) return '';
  const own = new Set([project.discovered?.backend, ...(project.services ?? [])].filter(Boolean));
  const blocks = [];

  // n8n hosts workflows
  if (server.n8n?.container && own.has(server.n8n.container)) {
    const mine = Object.entries(workflows).filter(([, w]) => w.server === project.server);
    const real = mine.filter(([, w]) => !w.noise);
    const active = real.filter(([, w]) => w.active);
    const tenants = allProjects.filter((pr) => pr.id !== project.id
      && (pr.workflows ?? []).some((wid) => workflows[wid]?.server === project.server));

    blocks.push(`<h3>Workflows it runs · ${active.length} active of ${real.length}</h3>
      <p>This is the n8n instance itself, not one automation inside it. It holds
      ${mine.length} workflows in total, of which ${mine.length - real.length} are demo
      templates that were imported and never removed.</p>
      ${tenants.length ? `<p>Projects with workflows running here:
        ${tenants.map((t) => linkProject(t.id, t.name)).join(', ')}.</p>` : ''}`);
  }

  // a database engine hosts collections
  if (own.has('mongod') || own.has('postgres') || own.has('postgresql')) {
    const dbs = Object.entries(server.databases ?? {});
    if (dbs.length) {
      blocks.push(`<h3>Databases it holds</h3><div class="table-wrap"><table>
        <thead><tr><th>Database</th><th>Collection</th><th>Documents</th></tr></thead>
        <tbody>${dbs.flatMap(([name, db]) => (db.collections ?? []).map((c) => `<tr>
          <td data-label="Database">${escapeHtml(name)}</td>
          <td data-label="Collection"><code>${escapeHtml(c.name)}</code></td>
          <td data-label="Documents" class="num">${fmt(c.docs ?? 0)}</td>
        </tr>`)).join('')}</tbody>
      </table></div>`);
    }
  }

  // a reverse proxy answers for hostnames
  if (own.has('nginx')) {
    const vhosts = (server.vhosts ?? []).filter((v) => v.source === 'nginx');
    blocks.push(`<h3>Hostnames it answers for · ${vhosts.length}</h3><div class="table-wrap"><table>
      <thead><tr><th>Domain</th><th>Goes to</th><th>Project</th></tr></thead>
      <tbody>${vhosts.map((v) => {
    const port = /:(\d{2,5})\b/.exec(v.proxyTo ?? '');
    const backing = port ? (server.services ?? []).concat(server.containers ?? [])
      .find((x) => x.port === Number(port[1]) || new RegExp(`:${port[1]}->`).test(x.ports ?? '')) : null;
    const owner = backing ? projectForService(backing.name, project.server, allProjects) : null;
    return `<tr>
          <td data-label="Domain">${escapeHtml(v.domain)}</td>
          <td data-label="Goes to"><code>${escapeHtml(v.proxyTo ?? v.root ?? '')}</code></td>
          <td data-label="Project">${owner ? linkProject(owner.id, owner.name) : '<span class="faint">—</span>'}</td>
        </tr>`;
  }).join('')}</tbody>
    </table></div>`);
  }

  return blocks.length ? `<h2>What runs on this</h2>${blocks.join('')}` : '';
}

/**
 * One plain sentence about a project nobody has written up, assembled from
 * what the dump actually contained. Better than an empty page, and honest
 * about being inferred.
 */
function describeDerived(project) {
  const d = project.discovered ?? {};
  const bits = [];

  if (d.hostnames?.length) {
    bits.push(`it answers ${d.hostnames.map((h) => `<code>${escapeHtml(h)}</code>`).join(' and ')}`);
  }
  if (d.backend && d.port) {
    bits.push(`traffic goes to <code>${escapeHtml(d.backend)}</code> on port <code>${d.port}</code>, currently ${escapeHtml(d.backendState ?? 'in an unknown state')}`);
  } else if (d.backend) {
    bits.push(`it runs as <code>${escapeHtml(d.backend)}</code>, currently ${escapeHtml(d.backendState ?? 'in an unknown state')}`);
  }
  if (d.directory) {
    bits.push(`the code lives in <code>${escapeHtml(d.directory)}</code>${d.size ? ` (${escapeHtml(d.size)})` : ''}`);
  }
  if (d.remote) bits.push('it is a git checkout');
  if (d.certExpiryDays != null) bits.push(`its certificate has ${d.certExpiryDays} days left`);

  return bits.length ? `${bits.join('; ')}.` : 'the dump recorded little beyond its name.';
}

/* ----------------------------------------------------- project drawer */

function renderIssue(issue) {
  const reconciled = issue.claimStatus === 'reconciled';
  const claim = issue.claimStatus ? `<div class="claim-note claim-note--${issue.claimStatus}">
    ${reconciled
    ? `Re-tested against the latest ingest: <strong>no longer reproduces</strong>. ${escapeHtml(issue.claimDetail ?? '')}. Looks fixed since this was written${issue.claim?.asOf ? ` on ${escapeHtml(issue.claim.asOf)}` : ''}.`
    : issue.claimStatus === 'holds'
      ? `Re-tested against the latest ingest: <strong>still true</strong>. ${escapeHtml(issue.claimDetail ?? '')}.`
      : `Could not re-test: ${escapeHtml(issue.claimDetail ?? '')}.`}
  </div>` : '';

  return `<div class="issue issue--${issue.severity}${reconciled ? ' reconciled' : ''}">
    <div class="issue-head">
      <span class="sev sev--${issue.severity}">${issue.severity}</span>
      <span class="issue-title">${escapeHtml(issue.title)}</span>
      ${issue.project ? `<span class="issue-link">${linkProject(issue.project)}</span>` : ''}
      ${issue.server ? `<span class="issue-link">${linkServer(issue.server)}</span>` : ''}
      <span class="faint" style="font:11px var(--mono)">${escapeHtml(issue.source)}</span>
    </div>
    <div class="issue-body">${escapeHtml(issue.body ?? '')}</div>
    ${issue.evidence ? `<div class="issue-evidence">${escapeHtml(issue.evidence)}</div>` : ''}
    ${claim}
  </div>`;
}

/**
 * Split a project doc on its `##` headings so each section can be rendered as
 * its own numbered panel. A dense board where everything is visible at once
 * beats a linear scroll for a reference document you read by jumping around.
 */
function splitSections(body) {
  const lines = String(body ?? '').split('\n');
  const sections = [];
  let current = { title: null, lines: [] };
  let inFence = false;

  for (const line of lines) {
    if (/^([ \t]{0,3})(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    const heading = !inFence && /^##\s+(.*)$/.exec(line);
    if (heading) {
      if (current.title || current.lines.some((l) => l.trim())) sections.push(current);
      current = { title: heading[1].trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.title || current.lines.some((l) => l.trim())) sections.push(current);

  return sections.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }));
}

function renderProjectPanel(project, { issues, workflows, servers, allProjects, glossary = {} }) {
  let flowSeq = 0;
  const renderBody = (markdown) => renderMarkdown(markdown, {
    onFence: (lang, code) => {
      if (lang !== 'flow') return null;
      const flow = parseFlow(code);
      if (flow.errors.length) {
        return `<div class="flow-wrap"><p class="faint">Flow could not be rendered: ${escapeHtml(flow.errors[0].message)}</p></div>`;
      }
      // Both orientations ship; CSS picks one. Laying out the same graph twice
      // is a few KB, and it is the only way a ten-layer diagram is legible on a
      // phone without JavaScript re-running the layout at runtime.
      flowSeq += 1;
      const opts = { id: `f-${project.id}-${flowSeq}`, title: `${project.name} flow`, glossary };
      return `<div class="flow-wrap"><div class="flow-scroll">${
        renderFlowSvg(flow, opts)
      }${
        renderFlowSvg(flow, { ...opts, id: `fv-${project.id}-${flowSeq}`, vertical: true })
      }</div></div>`;
    },
  });

  // Each `##` section becomes a numbered panel on a dense board.
  const sections = splitSections(project.body ?? '');
  const lead = sections.length && !sections[0].title ? renderBody(sections[0].body) : '';
  const panels = sections.filter((s) => s.title);

  const body = panels.length
    ? `<div class="board">${panels.map((section, i) => {
      const html = renderBody(section.body);
      // Decide the span from the SOURCE, not from sniffing rendered HTML.
      // Only widen what genuinely needs it: a diagram, or a table wide enough
      // to be cramped in one track. Widening every table is what made the board
      // sparse — panels spanning two of three tracks leave holes nothing fills.
      const tableCols = (section.body.match(/^\|.*\|\s*$/gm) ?? [])
        .map((row) => row.trim().split('|').length - 2)
        .reduce((a, b) => Math.max(a, b), 0);
      const hasFlow = /```flow/.test(section.body);
      const wide = hasFlow || tableCols >= 3;
      return `<section class="board-panel${hasFlow ? ' board-panel--flow' : wide ? ' board-panel--wide' : ''}">
        <h2 class="board-title"><span class="board-num">${i + 1}</span>${escapeHtml(section.title)}</h2>
        <div class="board-content">${html}</div>
      </section>`;
    }).join('')}</div>`
    : renderBody(project.body ?? '');

  const mine = issues.filter((i) => i.project === project.id && !i.resolved).sort(bySeverity);
  const d = project.discovered;

  // Every field we actually hold on each workflow, straight from the last
  // ingest. The doc lists ids; everything else here is live.
  const owned = (project.workflows ?? []).map((id) => ({ id, wf: workflows[id] }));
  const liveCount = owned.filter((o) => o.wf?.active).length;

  const wfRows = owned.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Workflow</th><th>State</th><th>Group</th><th>Server</th><th>First seen</th><th>Id</th></tr></thead>
    <tbody>${owned.map(({ id, wf }) => (wf ? `<tr>
      <td data-label="Workflow">${linkWorkflow(id, wf.name, wf.noise)}</td>
      <td data-label="State"><span class="dot dot--${wf.active ? 'live' : 'idle'}"></span> ${wf.active ? 'active' : 'off'}</td>
      <td data-label="Group">${escapeHtml(wf.group ?? '')}</td>
      <td data-label="Server">${wf.server ? `<a href="#server=${escapeHtml(wf.server)}" data-open="server:${escapeHtml(wf.server)}">${escapeHtml(wf.server)}</a>` : '—'}</td>
      <td data-label="First seen" class="num">${escapeHtml(wf.firstSeen ?? '')}</td>
      <td data-label="Id"><code>${escapeHtml(id)}</code></td>
    </tr>` : `<tr>
      <td data-label="Workflow" class="faint">unknown</td>
      <td data-label="State" class="faint">not in the ingested list</td>
      <td data-label="Group">—</td><td data-label="Server">—</td><td data-label="First seen">—</td>
      <td data-label="Id"><code>${escapeHtml(id)}</code></td>
    </tr>`)).join('')}</tbody>
  </table></div>` : '';

  /* ---- what this project is connected to, computed from live data ---- */
  const server = project.server ? servers[project.server] : null;
  const siblings = allProjects.filter((p) => p.id !== project.id && p.server === project.server);
  const sharedService = allProjects.filter((p) => p.id !== project.id
    && (p.services ?? []).some((svc) => (project.services ?? []).includes(svc)));

  const dbs = [];
  for (const [dbName, db] of Object.entries(server?.databases ?? {})) {
    const mentioned = new RegExp(`\b${dbName}\b`).test(project.body ?? '')
      || (project.stats ?? []).some((st) => String(st.ref ?? '').includes(dbName));
    if (mentioned) dbs.push({ name: dbName, ...db });
  }

  const hostnames = project.discovered?.hostnames ?? [];

  const connections = `
    ${hostnames.length ? `<h3>Reachable at</h3><ul>${hostnames.map((h) => `<li><code>${escapeHtml(h)}</code>${project.discovered?.port ? ` → <code>127.0.0.1:${project.discovered.port}</code>` : ''}</li>`).join('')}</ul>` : ''}

    ${dbs.length ? `<h3>Data it touches</h3><div class="table-wrap"><table>
      <thead><tr><th>Collection</th><th>Documents</th><th>Database</th></tr></thead>
      <tbody>${dbs.flatMap((db) => (db.collections ?? []).map((c) => `<tr>
        <td data-label="Collection"><code>${escapeHtml(c.name)}</code></td>
        <td data-label="Documents" class="num">${fmt(c.docs ?? 0)}</td>
        <td data-label="Database">${escapeHtml(db.name)} · ${escapeHtml(db.engine ?? '')}</td>
      </tr>`)).join('')}</tbody></table></div>` : ''}

    ${sharedService.length ? `<h3>Shares a process with</h3><ul>${sharedService.map((p) => `<li>
      <a href="#project=${escapeHtml(p.id)}" data-open="project:${escapeHtml(p.id)}">${escapeHtml(p.name)}</a>
      <span class="faint">${escapeHtml((p.services ?? []).join(', '))}</span></li>`).join('')}</ul>` : ''}

    ${siblings.length ? `<h3>Also on ${escapeHtml(project.server ?? '')}</h3>
      <div class="chip-list">${siblings.map((p) => `<a class="pill" href="#project=${escapeHtml(p.id)}" data-open="project:${escapeHtml(p.id)}">
        <span class="dot dot--${p.status}"></span>${escapeHtml(p.name)}</a>`).join('')}</div>` : ''}
  `.trim();

  return `<section class="drawer-panel" data-panel="project:${escapeHtml(project.id)}">
    <div class="tags" style="margin-bottom:14px">
      <span class="pill"><span class="dot dot--${project.status}"></span>${escapeHtml(project.status)}</span>
      ${project.server ? `<a class="pill" href="#server=${escapeHtml(project.server)}" data-open="server:${escapeHtml(project.server)}">${escapeHtml(project.server)}</a>` : ''}
      ${project.href ? `<a class="pill pill--accent" href="${escapeHtml(project.href)}" target="_blank" rel="noopener">open ↗</a>` : ''}
      ${(project.tags ?? []).map((t) => explain(t, glossary)).join('')}
    </div>

    ${project.stats?.length ? `<div class="stats" style="margin-bottom:18px;gap:24px">${project.stats.map((s) => `<div>
      <div class="stat-value${s.state ? ` stat-value--${s.state}` : ''}" style="font-size:20px">${escapeHtml(String(s.value))}</div>
      <div class="stat-label">${escapeHtml(s.label)}${s.ref ? ` <span class="faint">· live</span>` : ''}</div>
    </div>`).join('')}</div>` : ''}

    ${lead}
    ${project.origin === 'derived' ? `<p class="derived-note">
      <strong>No write-up for this one yet.</strong> Everything below was found on
      ${project.server ? linkServer(project.server) : 'the server'} rather than written down:
      ${describeDerived(project)}
      To document it, create <code>content/projects/${escapeHtml(project.id)}.md</code> and the
      prose will appear here above the discovered facts.
    </p>` : ''}
    ${body}

    ${d ? `<h2>Discovered on ${escapeHtml(project.server ?? '')}</h2>
    <dl class="kv">
      ${d.hostnames?.length ? `<dt>Hostnames</dt><dd>${d.hostnames.map(escapeHtml).join('<br>')}</dd>` : ''}
      ${d.backend ? `<dt>Backend</dt><dd>${escapeHtml(d.backend)} · ${escapeHtml(d.backendState ?? '')}</dd>` : ''}
      ${d.port ? `<dt>Port</dt><dd>${d.port}</dd>` : ''}
      ${d.directory ? `<dt>Directory</dt><dd>${escapeHtml(d.directory)}${d.size ? ` · ${escapeHtml(d.size)}` : ''}</dd>` : ''}
      ${d.remote ? `<dt>Git remote</dt><dd>${escapeHtml(d.remote)}</dd>` : ''}
      ${d.hasEnv ? '<dt>Env file</dt><dd>present, contents never read</dd>' : ''}
      ${d.certExpiryDays != null ? `<dt>Certificate</dt><dd>${d.certExpiryDays} days remaining</dd>` : ''}
    </dl>` : ''}

    ${wfRows ? `<h2>Workflows · ${liveCount} active of ${owned.length}</h2>${wfRows}` : ''}

    ${hostedBy(project, { servers, workflows, allProjects })}

    ${connections ? `<h2>Connected to</h2>${connections}` : ''}

    ${(() => {
    const used = Object.keys(glossary).filter((term) => {
      const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');
      return re.test(project.body ?? '') || (project.tags ?? []).some((t) => re.test(t));
    });
    if (!used.length) return '';
    return `<h2>What these things are</h2>
      <dl class="glossary">${used.map((term) => `
        <dt>${escapeHtml(term)}</dt>
        <dd><strong>${escapeHtml(glossary[term].what)}</strong> ${escapeHtml(glossary[term].why)}</dd>`).join('')}
      </dl>`;
  })()}

    ${mine.length ? `<h2>Issues · ${mine.length}</h2>${mine.map(renderIssue).join('')}` : ''}
  </section>`;
}



/* ------------------------------------------------------------ glossary */

/**
 * A tag or label that the glossary knows about becomes a hover explanation.
 * The question a newcomer has is never just "what is this" but "why is it in
 * the picture", so both halves ship together.
 */
function explain(label, glossary, className = 'tag') {
  const term = glossary?.[label];
  if (!term) return `<span class="${className}">${escapeHtml(label)}</span>`;
  return `<span class="${className} term" tabindex="0" role="note">${escapeHtml(label)}<span class="term-card">
    <strong>${escapeHtml(term.what)}</strong>
    <span>${escapeHtml(term.why)}</span>
  </span></span>`;
}

/* --------------------------------------------------------------- links */

/**
 * Every relationship in this dashboard is navigable in both directions. These
 * three helpers are the only way a link is written, so nothing that has a
 * destination is ever rendered as plain text by accident.
 */
const linkProject = (id, label) => `<a href="#project=${escapeHtml(id)}" data-open="project:${escapeHtml(id)}">${escapeHtml(label ?? id)}</a>`;
const linkServer = (id, label) => `<a href="#server=${escapeHtml(id)}" data-open="server:${escapeHtml(id)}">${escapeHtml(label ?? id)}</a>`;
// A template import gets no page, so it is plain text rather than a dead link.
const linkWorkflow = (id, label, noise) => (noise
  ? escapeHtml(label ?? id)
  : `<a href="#workflow=${escapeHtml(id)}" data-open="workflow:${escapeHtml(id)}">${escapeHtml(label ?? id)}</a>`);

/**
 * Which project a service or container name belongs to.
 *
 * Priority matters. A platform is listed as a service by everything that runs
 * on it: Yamini declares `n8n-n8n-1` because it runs there, but it does not
 * own n8n — n8n hosts 135 workflows of which Yamini is one. So a project whose
 * discovered BACKEND is this service wins over one that merely mentions it,
 * and clicking n8n in a diagram lands on n8n rather than on its best-known
 * tenant.
 */
function projectForService(name, serverId, projects) {
  if (!name) return null;
  const onServer = projects.filter((p) => p.server === serverId);
  return onServer.find((p) => p.discovered?.backend === name)
    ?? onServer.find((p) => (p.services ?? []).includes(name))
    ?? null;
}

/** Which project owns a workflow id. */
function projectForWorkflow(id, projects) {
  return projects.find((p) => (p.workflows ?? []).includes(id)) ?? null;
}

/* ------------------------------------------------------ workflow page */

/**
 * Workflows used to be dead ends: named in three places, openable from none.
 * Each one now has a page carrying everything held about it plus every thing
 * it is attached to.
 */
function renderWorkflowPanel(id, wf, { projects, workflows, servers, issues }) {
  const owner = projectForWorkflow(id, projects);
  const server = wf.server ? servers[wf.server] : null;
  const siblings = wf.noise ? [] : Object.entries(workflows)
    .filter(([wid, w]) => wid !== id && w.group === wf.group && !w.noise)
    .sort((a, b) => (b[1].active - a[1].active) || a[1].name.localeCompare(b[1].name));

  const sameName = Object.entries(workflows).filter(([wid, w]) => wid !== id && w.name === wf.name);

  const history = (wf.history ?? []).slice().reverse();

  return `<section class="drawer-panel" data-panel="workflow:${escapeHtml(id)}"
      data-title="${escapeHtml(wf.name)}" data-state="${wf.active ? 'live' : 'idle'}"
      data-sub="${escapeHtml(`${wf.group ?? 'Ungrouped'} · ${id}`)}">
    <p class="section-note">
      An automation running inside n8n${wf.server ? ` on ${linkServer(wf.server)}` : ''}. It is currently
      <strong>${wf.active ? 'switched on and running' : 'switched off'}</strong>.
      ${wf.noise
    ? 'This is one of roughly a hundred demo templates that were imported into n8n and never removed. It is almost certainly not something anyone built.'
    : 'Workflows are how every integration in this estate is built, so this page is the closest thing to source code for it.'}
    </p>
    <div class="tags" style="margin-bottom:14px">
      <span class="pill"><span class="dot dot--${wf.active ? 'live' : 'idle'}"></span>${wf.active ? 'active' : 'off'}</span>
      <span class="pill">${escapeHtml(wf.group ?? 'Ungrouped')}</span>
      ${wf.server ? `<a class="pill" href="#server=${escapeHtml(wf.server)}" data-open="server:${escapeHtml(wf.server)}">${escapeHtml(wf.server)}</a>` : ''}
      ${owner ? `<a class="pill pill--accent" href="#project=${escapeHtml(owner.id)}" data-open="project:${escapeHtml(owner.id)}">${escapeHtml(owner.name)}</a>` : ''}
      ${wf.noise ? '<span class="pill">template import</span>' : ''}
    </div>

    <div class="board">
      <section class="board-panel">
        <h2 class="board-title"><span class="board-num">1</span>Identity</h2>
        <div class="board-content"><dl class="kv">
          <dt>Name</dt><dd>${escapeHtml(wf.name)}</dd>
          <dt>Id</dt><dd>${escapeHtml(id)}</dd>
          <dt>State</dt><dd>${wf.active ? 'active' : 'inactive'}</dd>
          <dt>Group</dt><dd>${escapeHtml(wf.group ?? 'Ungrouped')}</dd>
          <dt>Host</dt><dd>${wf.server ? linkServer(wf.server) : 'unknown'}${server?.n8n?.container ? ` · ${escapeHtml(server.n8n.container)}` : ''}</dd>
          <dt>First seen</dt><dd>${escapeHtml(wf.firstSeen ?? '')}</dd>
          <dt>Last seen</dt><dd>${escapeHtml(wf.lastSeen ?? '')}</dd>
          ${wf.missingSince ? `<dt>Missing since</dt><dd>${escapeHtml(wf.missingSince)}</dd>` : ''}
        </dl></div>
      </section>

      <section class="board-panel">
        <h2 class="board-title"><span class="board-num">2</span>Belongs to</h2>
        <div class="board-content">
          ${owner
    ? `<p>Owned by ${linkProject(owner.id, owner.name)}, which is documented in <code>${escapeHtml(owner.sourceFile ?? '')}</code>.</p>`
    : '<p class="faint">No project claims this workflow. Add its id to a project doc\'s <code>workflows:</code> list to attach it.</p>'}
          ${wf.server ? `<p>Runs on ${linkServer(wf.server)}.</p>` : ''}
          ${sameName.length ? `<p><strong>Name collision.</strong> ${sameName.length} other workflow${sameName.length === 1 ? '' : 's'} share this exact name:</p>
            <ul>${sameName.map(([wid, w]) => `<li>${linkWorkflow(wid, wid)} <span class="faint">${w.active ? 'active' : 'off'}</span></li>`).join('')}</ul>` : ''}
        </div>
      </section>

      ${history.length ? `<section class="board-panel">
        <h2 class="board-title"><span class="board-num">3</span>State history</h2>
        <div class="board-content"><div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>State</th></tr></thead>
          <tbody>${history.map((h) => `<tr>
            <td data-label="Date" class="num">${escapeHtml(h.date)}</td>
            <td data-label="State"><span class="dot dot--${h.active ? 'live' : 'idle'}"></span> ${h.active ? 'activated' : 'deactivated'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        ${history.length === 1 ? '<p class="faint">One entry means this is the first sighting, not a change.</p>' : ''}
        </div>
      </section>` : ''}

      ${siblings.length ? `<section class="board-panel board-panel--wide">
        <h2 class="board-title"><span class="board-num">${history.length ? 4 : 3}</span>Others in ${escapeHtml(wf.group ?? 'this group')}</h2>
        <div class="board-content"><div class="table-wrap"><table>
          <thead><tr><th>Workflow</th><th>State</th><th>Project</th></tr></thead>
          <tbody>${siblings.slice(0, 12).map(([wid, w]) => {
    const o = projectForWorkflow(wid, projects);
    return `<tr>
              <td data-label="Workflow">${linkWorkflow(wid, w.name, w.noise)}</td>
              <td data-label="State"><span class="dot dot--${w.active ? 'live' : 'idle'}"></span> ${w.active ? 'active' : 'off'}</td>
              <td data-label="Project">${o ? linkProject(o.id, o.name) : '<span class="faint">unclaimed</span>'}</td>
            </tr>`;
  }).join('')}</tbody>
        </table></div></div>
      </section>` : ''}
    </div>
  </section>`;
}

/* ------------------------------------------------------------- tree */

/**
 * The estate as a tree: server, then its projects, then the workflows each one
 * owns. Built from live data, so it is the actual shape of the estate rather
 * than a drawing of it.
 */
function renderTree(servers, projects, workflows) {
  const owned = new Map();
  for (const p of projects) for (const id of p.workflows ?? []) owned.set(id, p.id);

  return `<div class="tree">${Object.entries(servers).map(([id, server]) => {
    const mine = projects.filter((p) => p.server === id);
    const serverWf = Object.entries(workflows).map(([wid, w]) => ({ id: wid, ...w })).filter((w) => w.server === id);
    const unowned = serverWf.filter((w) => !owned.has(w.id) && !w.noise);
    const noise = serverWf.filter((w) => w.noise).length;

    return `<details class="tree-node tree-node--server" open>
      <summary>
        <span class="dot dot--${server.state?.firewall === 'active' ? 'live' : 'broken'}"></span>
        <a href="#server=${escapeHtml(id)}" data-open="server:${escapeHtml(id)}">${escapeHtml(id)}</a>
        <span class="tree-meta">${escapeHtml(server.role ?? '')}</span>
        <span class="tree-count">${mine.length} projects · ${serverWf.length} workflows</span>
      </summary>
      <div class="tree-children">
        ${mine.map((p) => {
    const wf = (p.workflows ?? []).map((w) => (workflows[w] ? { id: w, ...workflows[w] } : null)).filter(Boolean);
    const active = wf.filter((w) => w.active).length;
    return `<details class="tree-node"${wf.length ? '' : ' data-leaf'}>
          <summary>
            <span class="dot dot--${p.status}"></span>
            <a href="#project=${escapeHtml(p.id)}" data-open="project:${escapeHtml(p.id)}">${escapeHtml(p.name)}</a>
            ${p.discovered?.port ? `<span class="tree-meta">:${p.discovered.port}</span>` : ''}
            ${wf.length ? `<span class="tree-count">${active} of ${wf.length} active</span>` : ''}
          </summary>
          ${wf.length ? `<div class="tree-children">${wf
      .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name))
      .map((w) => `<div class="tree-leaf">
              <span class="dot dot--${w.active ? 'live' : 'idle'}"></span>
              <span class="tree-name">${escapeHtml(w.name)}</span>
              <span class="tree-meta">${escapeHtml(w.group ?? '')}</span>
            </div>`).join('')}</div>` : ''}
        </details>`;
  }).join('')}
        ${unowned.length ? `<details class="tree-node">
          <summary><span class="dot dot--idle"></span>
            <span class="tree-name">Workflows with no project</span>
            <span class="tree-count">${unowned.filter((w) => w.active).length} of ${unowned.length} active</span>
          </summary>
          <div class="tree-children">${unowned
    .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name))
    .map((w) => `<div class="tree-leaf">
              <span class="dot dot--${w.active ? 'live' : 'idle'}"></span>
              <span class="tree-name">${linkWorkflow(w.id, w.name, w.noise)}</span>
              <span class="tree-meta">${escapeHtml(w.group ?? '')}</span>
            </div>`).join('')}</div>
        </details>` : ''}
        ${noise ? `<div class="tree-leaf faint">${noise} template imports, hidden</div>` : ''}
      </div>
    </details>`;
  }).join('')}</div>`;
}

/* --------------------------------------------------- workflow explorer */

function renderWorkflows(workflows, projects) {
  const owner = new Map();
  for (const p of projects) for (const id of p.workflows ?? []) owner.set(id, p);

  const groups = new Map();
  for (const [id, wf] of Object.entries(workflows)) {
    const key = wf.group ?? 'Ungrouped';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id, ...wf });
  }

  const order = ['Yamini', 'Attribution', 'HR', 'Sales QA', 'KW GBT', 'Web chat', 'Ungrouped'];
  const sorted = [...groups.entries()].sort((a, b) => {
    const ai = order.indexOf(a[0]); const bi = order.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return sorted.map(([group, list]) => {
    list.sort((a, b) => (b.active - a.active) || (a.noise - b.noise) || a.name.localeCompare(b.name));
    const active = list.filter((w) => w.active).length;
    const noise = list.filter((w) => w.noise).length;
    const isNoiseGroup = noise > list.length / 2;

    return `<details class="wf-group"${isNoiseGroup ? '' : ' open'}>
      <summary>${escapeHtml(group)}
        <span class="wf-count">${active} active · ${list.length} total${noise ? ` · ${noise} imports` : ''}</span>
      </summary>
      <div class="wf-list">${list.map((w) => {
      const own = owner.get(w.id);
      return `<div class="wf${w.noise ? ' wf--noise' : ''} searchable" data-search="${escapeHtml(`${w.name} ${w.id} ${group} ${w.server ?? ''}`.toLowerCase())}">
        <span class="dot dot--${w.active ? 'live' : 'idle'}"></span>
        <span class="wf-name">${linkWorkflow(w.id, w.name, w.noise)}</span>
        ${own ? `<span class="wf-id">${linkProject(own.id, own.name)}</span>` : ''}
        ${w.server ? `<span class="wf-id">${escapeHtml(w.server)}</span>` : ''}
        <span class="wf-id">${escapeHtml(w.id)}</span>
      </div>`;
    }).join('')}</div>
    </details>`;
  }).join('');
}

/* ----------------------------------------------------- costs & renewals */

/**
 * Every recurring bill, soonest renewal first.
 *
 * The list is derived — three VPS, every registrable domain nginx answers for —
 * so it is complete whether or not anyone recorded a price. A blank renders as
 * "not recorded" rather than as zero, because "we do not know what this costs"
 * and "this is free" are very different sentences and only one of them is true.
 */
function renewalsPanel(costs) {
  if (!costs?.lines?.length) return '';

  const money = (n) => (Number.isFinite(n) ? `₹${Math.round(n).toLocaleString('en-IN')}` : null);
  const KIND = { vps: 'VPS', domain: 'Domain' };

  /* Days-remaining is the ordinal scale. A cancelled line jumps straight to
     critical whatever the count says: it is not a bill approaching, it is a
     shutdown approaching, and those deserve different alarm. */
  const due = (line) => {
    if (line.autoRenew === false) return { text: 'will not renew', tone: 'critical' };
    if (line.daysUntil === null || line.daysUntil === undefined) return { text: 'no date', tone: 'unknown' };
    if (line.daysUntil < 0) return { text: `${-line.daysUntil}d overdue`, tone: 'critical' };
    if (line.daysUntil <= 14) return { text: `in ${line.daysUntil}d`, tone: 'high' };
    if (line.daysUntil <= 45) return { text: `in ${line.daysUntil}d`, tone: 'medium' };
    return { text: `in ${line.daysUntil}d`, tone: 'ok' };
  };

  // Only lines someone has actually recorded. The derivation still walks every
  // server and domain — that is what the count below is — but a row of three
  // "not recorded" cells is a placeholder, not a fact, and it crowds out four
  // rows that are.
  const known = costs.lines.filter((l) => Number.isFinite(l.amount) || l.nextDate);
  if (known.length === 0) return '';

  const rows = known.map((line) => {
    const d = due(line);
    const label = line.kind === 'vps' && line.server ? linkServer(line.server, line.label) : escapeHtml(line.label);
    const gross = money(line.gross);
    const cycle = (line.cycle ?? 'monthly').startsWith('ye') ? 'yr' : 'mo';
    // Charge date while it renews, expiry once it does not — different events,
    // and the label has to say which one you are looking at.
    const dateLabel = line.autoRenew === false ? 'expires' : 'charged';

    return `<tr${line.autoRenew === false ? ' class="renewal-row--cancelled"' : ''}>
      <th scope="row" data-label="Line">${label}
        <span class="renewal-kind">${escapeHtml(line.plan ?? KIND[line.kind] ?? line.kind)}</span>
        ${line.detail ? `<span class="renewal-detail">${escapeHtml(line.detail)}</span>` : ''}
      </th>
      <!-- Every cell's content is wrapped in one .cell. Under 768px each td
           becomes a two-column grid (label | value), and a bare text node plus
           two block spans would each be placed as separate grid items — "/yr"
           and "charged" ended up in the label column as rows of their own. -->
      <td data-label="Provider"><span class="cell">${line.provider ? escapeHtml(line.provider) : '<span class="unrecorded">—</span>'}</span></td>
      <td class="num" data-label="Cost"><span class="cell">${gross
    ? `${gross}<span class="renewal-cycle">/${cycle}</span>${Number.isFinite(line.tax) && line.tax > 0 ? `<span class="renewal-detail">${money(line.amount)} + ${money(line.tax)} tax</span>` : ''}`
    : '<span class="unrecorded">not recorded</span>'}</span></td>
      <td data-label="Next"><span class="cell">${line.nextDate
    ? `${escapeHtml(line.nextDate)}<span class="renewal-detail">${dateLabel}</span>`
    : '<span class="unrecorded">not recorded</span>'}</span></td>
      <td data-label="Due"><span class="cell"><span class="renewal-due tone-${d.tone}">${escapeHtml(d.text)}</span></span></td>
    </tr>`;
  }).join('');

  const missing = costs.lines.length - known.length;

  return `<figure class="chart renewals" id="renewals">
    <figcaption>Recurring cost and renewals</figcaption>
    <p class="chart-note">
      ${costs.monthlyTotal !== null
    ? `<strong>${money(costs.monthlyTotal)}/month</strong>, ${money(costs.annualTotal)} a year including GST, across ${costs.recorded} priced line${costs.recorded === 1 ? '' : 's'}.`
    : 'Nothing is priced yet.'}
      ${missing > 0
    ? `${missing} further derived line${missing === 1 ? '' : 's'} — registered elsewhere, not priced — ${missing === 1 ? 'is' : 'are'} hidden until recorded in <code>data/costs.json</code>.`
    : 'Every derived line is accounted for.'}
    </p>
    <div class="table-wrap">
      <table class="renewal-table">
        <thead><tr><th scope="col">Line</th><th scope="col">Provider</th><th scope="col">Cost</th><th scope="col">Renews</th><th scope="col">Due</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </figure>`;
}

/* --------------------------------------------------------------- page */

export function renderPage({
  servers, projects, workflows, issues, events, history, staleness, analysis, costs, glossary, css, builtAt,
}) {
  const openIssues = issues.filter((i) => !i.resolved);
  const globalIssues = openIssues.filter((i) => !i.project).sort(bySeverity);
  const reconciled = issues.filter((i) => i.claimStatus === 'reconciled');

  const wfGroups = (() => {
    const map = new Map();
    for (const wf of Object.values(workflows)) {
      if (wf.noise) continue;
      const key = wf.group ?? 'Ungrouped';
      const row = map.get(key) ?? { group: key, active: 0, inactive: 0 };
      if (wf.active) row.active += 1; else row.inactive += 1;
      map.set(key, row);
    }
    return [...map.values()].sort((a, b) => (b.active - a.active) || (b.inactive - a.inactive));
  })();

  const serverIds = Object.keys(servers);

  return `<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>KW Estate</title>
<meta name="description" content="Every server, project and workflow KW Group runs, read out of diagnostic dumps taken off the machines themselves.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230d1226'/%3E%3Cpath d='M9 8v16M9 16l8-8M9 16l8 8' stroke='%2335e0c8' stroke-width='2.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='24' cy='16' r='2.6' fill='%2335e0c8'/%3E%3C/svg%3E">
<script>
/* Runs before first paint, so the chosen theme is never repainted in front of
   the reader. Stored choice wins; otherwise the OS preference decides, with
   dark as the fallback when neither says anything. */
(function () {
  try {
    var saved = localStorage.getItem('kw-estate-theme');
    var theme = (saved === 'light' || saved === 'dark') ? saved
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}());
</script>
<style>
${css}
</style>
</head>
<body>

<header class="top">
  <div class="top-inner">
    <div class="brand">KW Estate <span>· infrastructure knowledge</span></div>
    <input class="search" id="search" type="search" placeholder="Search anything  (press /)" autocomplete="off">
    <div class="top-actions">
      <div class="built">built ${escapeHtml(builtAt)}</div>
      <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch theme" aria-pressed="false" title="Switch theme">
        <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-13.5a1 1 0 0 1 1 1V6a1 1 0 1 1-2 0V4.5a1 1 0 0 1 1-1zm0 15a1 1 0 0 1 1 1V21a1 1 0 1 1-2 0v-1.5a1 1 0 0 1 1-1zM3.5 12a1 1 0 0 1 1-1H6a1 1 0 1 1 0 2H4.5a1 1 0 0 1-1-1zm14.5 0a1 1 0 0 1 1-1H21a1 1 0 1 1 0 2h-1.5a1 1 0 0 1-1-1zM5.6 5.6a1 1 0 0 1 1.4 0l1 1a1 1 0 1 1-1.4 1.4l-1-1a1 1 0 0 1 0-1.4zm10.4 10.4a1 1 0 0 1 1.4 0l1 1a1 1 0 0 1-1.4 1.4l-1-1a1 1 0 0 1 0-1.4zm2.4-10.4a1 1 0 0 1 0 1.4l-1 1A1 1 0 0 1 16 6.6l1-1a1 1 0 0 1 1.4 0zM8 16a1 1 0 0 1 0 1.4l-1 1A1 1 0 0 1 5.6 17l1-1a1 1 0 0 1 1.4 0z"/></svg>
      </button>
    </div>
  </div>
</header>

<div class="results" id="results" hidden>
  <div class="results-head">
    <span id="results-count"></span>
    <button class="chip" id="results-clear" type="button">Clear</button>
  </div>
  <div id="results-list"></div>
</div>

<main class="wrap" id="dashboard">
  ${renderIntro({ servers, projects, workflows, builtAt })}
  ${renderTiles({ servers, projects, workflows, issues, history })}

  ${section('What changed', 'Differences between the two most recent collections of each server: units that failed, ports that opened, certificates running down, workflows switched off. This is the thing a static inventory cannot tell you.')}
  ${renderChanges(events)}

  ${section('Servers', 'The three Hostinger VPS the whole estate runs on. The stripe down the left edge is health, the bars are disk and memory at last collection. Open one for its full inventory.', String(serverIds.length))}
  <div class="servers">
    ${serverIds.map((id) => renderServerCard(id, servers[id], {
    issues: openIssues, history: history[id] ?? { disk: [] }, staleDays: staleness[id], projects, workflows,
  })).join('')}
  </div>

  ${section('Analysis', 'Three questions the raw inventory does not answer: where the leads stop, how many workflows actually run, and what the whole thing costs to operate each month.')}
  <div class="chart-grid">
    ${analysis.funnel ? funnelChart(analysis.funnel.stages, { title: analysis.funnel.title, id: 'funnel' }) : ''}
    ${workflowChart(wfGroups, { title: 'Workflows by group, template imports excluded', id: 'wf-chart' })}
    ${analysis.costScenarios ? costChart(analysis.costScenarios.rows, { title: analysis.costScenarios.title, id: 'cost', note: costs?.note ?? null }) : ''}
    ${renewalsPanel(costs)}
  </div>

  ${section('Estate tree', 'The shape of the estate, generated from live data rather than drawn. Workflows belonging to no project are called out rather than quietly dropped.', 'server → project → workflow')}
  ${renderTree(servers, projects, workflows)}

  ${section('Projects', 'Everything reachable at a hostname or running as a systemd unit, discovered from the servers themselves. A few carry a written brief; the rest are described from what was found on disk.', `${projects.length} across ${serverIds.length} servers`)}
  <div class="filter-row" id="project-filters">
    <button class="chip" type="button" data-filter="all" aria-pressed="true">All</button>
    ${serverIds.map((id) => `<button class="chip" type="button" data-filter="${escapeHtml(id)}" aria-pressed="false">${escapeHtml(id)}</button>`).join('')}
    <button class="chip" type="button" data-filter="documented" aria-pressed="false">Documented</button>
    <button class="chip" type="button" data-filter="broken" aria-pressed="false">Not healthy</button>
  </div>
  <div class="projects" id="projects">
    ${projects.map((p) => renderProjectCard(p, { servers, workflows })).join('')}
  </div>

  ${section('Issues', 'Findings written by hand plus findings detected automatically on every collection. A hand-written finding is re-tested against the newest data, so one that has since been fixed shows struck through rather than being repeated as fact.', `${openIssues.filter((i) => i.claimStatus !== 'reconciled').length} open${reconciled.length ? ` · ${reconciled.length} reconciled` : ''}`)}
  ${globalIssues.length ? globalIssues.map(renderIssue).join('') : '<div class="changes"><div class="empty">No estate-wide issues.</div></div>'}

  ${section('Workflow inventory', 'Every n8n workflow on every server, grouped by what it does. Roughly a hundred are demo templates that were imported and never removed; they are grouped separately and collapsed.', `${Object.values(workflows).filter((w) => w.active).length} active of ${Object.keys(workflows).length}`)}
  <div class="wf-groups">${renderWorkflows(workflows, projects)}</div>
</main>

<section class="detail" id="detail" aria-hidden="true" tabindex="-1" aria-labelledby="detail-title">
  <div class="detail-head">
    <button class="back" id="detail-close" type="button">
      <svg viewBox="0 0 24 24" aria-hidden="true" width="15" height="15"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z"/></svg>
      Estate
    </button>
    <span class="dot" id="detail-dot"></span>
    <div class="detail-heading">
      <h1 class="detail-title" id="detail-title">—</h1>
      <div class="detail-sub" id="detail-sub"></div>
    </div>
  </div>
  <div class="detail-body" id="detail-body">
    ${projects.map((p) => renderProjectPanel(p, { issues, workflows, servers, allProjects: projects, glossary })).join('')}
    ${serverIds.map((id) => renderServerPanel(id, servers[id], { projects, workflows, issues: openIssues, glossary })).join('')}
    ${Object.entries(workflows)
    .filter(([, wf]) => !wf.noise)
    .map(([id, wf]) => renderWorkflowPanel(id, wf, { projects, workflows, servers, issues })).join('')}
  </div>
</section>

<script type="application/json" id="search-index">${
  JSON.stringify(buildSearchIndex({ servers, projects, workflows, issues }))
    .replace(/</g, '\\u003c')
}</script>
<script>
${clientScript()}
</script>
</body>
</html>`;
}

/* ------------------------------------------------------ client script */

function clientScript() {
  return `(function () {
  'use strict';

  var body = document.body;
  var drawer = document.getElementById('detail');
  var titleEl = document.getElementById('detail-title');
  var subEl = document.getElementById('detail-sub');
  var dotEl = document.getElementById('detail-dot');
  var search = document.getElementById('search');
  var current = null;

  // --- theme ----------------------------------------------------------
  var root = document.documentElement;
  var toggle = document.getElementById('theme-toggle');
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function syncToggle() {
    var light = root.getAttribute('data-theme') === 'light';
    toggle.setAttribute('aria-pressed', String(light));
    toggle.title = light ? 'Switch to dark' : 'Switch to light';
  }
  syncToggle();

  toggle.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('kw-estate-theme', next); } catch (e) { /* private mode */ }
    syncToggle();
  });

  // Follow the OS only while the reader has never expressed a preference.
  if (media && media.addEventListener) {
    media.addEventListener('change', function (e) {
      var stored = null;
      try { stored = localStorage.getItem('kw-estate-theme'); } catch (err) { /* ignore */ }
      if (stored) return;
      root.setAttribute('data-theme', e.matches ? 'light' : 'dark');
      syncToggle();
    });
  }

  function panelFor(key) {
    return document.querySelector('[data-panel="' + CSS.escape(key) + '"]');
  }
  function triggerFor(key) {
    return document.querySelector('button[data-open="' + CSS.escape(key) + '"]');
  }

  function open(key, push) {
    var panel = panelFor(key);
    if (!panel) return;

    var panels = document.querySelectorAll('.drawer-panel');
    for (var i = 0; i < panels.length; i++) panels[i].classList.toggle('is-active', panels[i] === panel);

    var kind = key.split(':')[0];
    var id = key.slice(kind.length + 1);
    var trigger = triggerFor(key);

    if (kind === 'project' && trigger) {
      titleEl.textContent = trigger.querySelector('.project-name').textContent;
      subEl.textContent = trigger.querySelector('.project-sub') ? trigger.querySelector('.project-sub').textContent : '';
      dotEl.className = trigger.querySelector('.dot').className;
    } else if (kind === 'server') {
      titleEl.textContent = id;
      var role = trigger ? trigger.querySelector('.server-role') : null;
      subEl.textContent = role ? role.textContent : '';
      dotEl.className = 'dot dot--live';
    } else if (kind === 'workflow') {
      var meta = panel.getAttribute('data-title') || id;
      titleEl.textContent = meta;
      subEl.textContent = panel.getAttribute('data-sub') || '';
      dotEl.className = 'dot dot--' + (panel.getAttribute('data-state') || 'idle');
    } else {
      titleEl.textContent = id;
      subEl.textContent = '';
    }

    if (body.classList.contains('searching')) {
      search.value = '';
      results.hidden = true;
      dashboard.hidden = false;
      body.classList.remove('searching');
    }
    body.classList.add('detail-open');
    drawer.setAttribute('aria-hidden', 'false');
    window.scrollTo(0, 0);
    drawer.focus({ preventScroll: true });
    current = key;

    var hash = '#' + kind + '=' + id;
    if (push !== false && location.hash !== hash) history.pushState(null, '', hash);
  }

  function close() {
    body.classList.remove('detail-open');
    drawer.setAttribute('aria-hidden', 'true');
    var trigger = current ? triggerFor(current) : null;
    current = null;
    if (trigger) trigger.focus();
    if (location.hash) history.pushState(null, '', location.pathname + location.search);
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-open]') : null;
    if (!el) return;
    e.preventDefault();
    open(el.getAttribute('data-open'));
  });

  document.getElementById('detail-close').addEventListener('click', close);

  // --- swipe right to go back (touch only) ----------------------------
  (function () {
    var startX = 0;
    var startY = 0;
    var startedAt = 0;
    var tracking = false;

    drawer.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') return;
      tracking = true;
      startX = e.clientX;
      startY = e.clientY;
      startedAt = e.timeStamp;
    });

    drawer.addEventListener('pointerup', function (e) {
      if (!tracking) return;
      tracking = false;
      var dx = e.clientX - startX;
      var dy = Math.abs(e.clientY - startY);
      var velocity = dx / Math.max(1, e.timeStamp - startedAt);
      // Mostly-horizontal, rightward, and either long or fast.
      if (dx > 70 && dy < 60 && (dx > 130 || velocity > 0.4)) close();
    });

    drawer.addEventListener('pointercancel', function () { tracking = false; });
  }());

  // --- deep links -----------------------------------------------------
  function fromHash(push) {
    var m = /^#(project|server|workflow)=(.+)$/.exec(location.hash);
    if (m) open(m[1] + ':' + decodeURIComponent(m[2]), push);
    else if (current) close();
  }
  window.addEventListener('hashchange', function () { fromHash(false); });
  fromHash(false);

  // --- search ---------------------------------------------------------
  var index = [];
  try {
    index = JSON.parse(document.getElementById('search-index').textContent) || [];
  } catch (e) { index = []; }

  var dashboard = document.getElementById('dashboard');
  var results = document.getElementById('results');
  var resultsList = document.getElementById('results-list');
  var resultsCount = document.getElementById('results-count');

  var KIND_ORDER = { server: 0, project: 1, issue: 2, workflow: 3 };

  function score(entry, q) {
    var label = entry.label.toLowerCase();
    if (label === q) return 0;
    if (label.indexOf(q) === 0) return 1;
    if (label.indexOf(q) !== -1) return 2;
    if (entry.text.indexOf(q) !== -1) return 3;
    return -1;
  }

  function render(q) {
    var hits = [];
    for (var i = 0; i < index.length; i++) {
      var rank = score(index[i], q);
      if (rank === -1) continue;
      // A demo template nobody wrote should never outrank a real thing.
      hits.push({ entry: index[i], rank: rank + (index[i].noise ? 4 : 0) });
    }

    hits.sort(function (a, b) {
      return a.rank - b.rank
        || (KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind])
        || a.entry.label.localeCompare(b.entry.label);
    });

    resultsCount.textContent = hits.length
      ? hits.length + (hits.length === 1 ? ' match for ' : ' matches for ') + '"' + q + '"'
      : 'Nothing matches "' + q + '"';

    if (!hits.length) {
      resultsList.innerHTML = '<p class="empty">No server, project, workflow or issue mentions that. '
        + 'Search covers names, hostnames, tags, ids and issue text.</p>';
      return;
    }

    var html = '';
    for (var h = 0; h < Math.min(hits.length, 60); h++) {
      var e = hits[h].entry;
      html += '<' + (e.open ? 'a href="#' + e.open.replace(':', '=') + '" data-open="' + e.open + '"' : 'div')
        + ' class="result">'
        + '<span class="result-kind result-kind--' + e.kind + '">' + e.kind + '</span>'
        + (e.state ? '<span class="dot dot--' + e.state + '"></span>' : '<span class="dot" style="opacity:0"></span>')
        + '<span class="result-label">' + e.label.replace(/[<>&]/g, '') + '</span>'
        + '<span class="result-sub">' + (e.sub || '').replace(/[<>&]/g, '') + '</span>'
        + '</' + (e.open ? 'a' : 'div') + '>';
    }
    if (hits.length > 60) html += '<p class="empty">' + (hits.length - 60) + ' more not shown. Narrow the search.</p>';
    resultsList.innerHTML = html;
  }

  function applySearch() {
    var q = search.value.trim().toLowerCase();
    if (!q) {
      results.hidden = true;
      dashboard.hidden = false;
      body.classList.remove('searching');
      return;
    }
    // Searching replaces the dashboard rather than filtering inside it, so it
    // is never ambiguous whether anything happened.
    body.classList.add('searching');
    dashboard.hidden = true;
    results.hidden = false;
    if (body.classList.contains('detail-open')) close();
    render(q);
  }

  search.addEventListener('input', applySearch);
  document.getElementById('results-clear').addEventListener('click', function () {
    search.value = '';
    applySearch();
    search.focus();
  });

  search.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var first = resultsList.querySelector('a.result');
    if (first) { e.preventDefault(); first.click(); }
  });

  // --- project filters ------------------------------------------------
  var filterRow = document.getElementById('project-filters');
  var cards = [].slice.call(document.querySelectorAll('#projects .project'));

  filterRow.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    var value = chip.getAttribute('data-filter');

    var chips = filterRow.querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) chips[i].setAttribute('aria-pressed', String(chips[i] === chip));

    for (var c = 0; c < cards.length; c++) {
      var card = cards[c];
      var show = value === 'all'
        || (value === 'documented' && card.querySelector('.doc-flag'))
        || (value === 'broken' && card.getAttribute('data-status') !== 'live')
        || card.getAttribute('data-server') === value;
      card.style.display = show ? '' : 'none';
    }
  });

  // --- keyboard -------------------------------------------------------
  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

    if (e.key === '/' && !typing) { e.preventDefault(); search.focus(); search.select(); return; }

    if (e.key === 'Escape') {
      if (document.activeElement === search && search.value) { search.value = ''; applySearch(); return; }
      if (document.activeElement === search) { search.blur(); return; }
      if (body.classList.contains('detail-open')) close();
      return;
    }
    if (typing) return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      var visible = cards.filter(function (c) {
        return c.style.display !== 'none' && !c.classList.contains('no-match');
      });
      if (!visible.length) return;
      var step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
      var idx = current && current.indexOf('project:') === 0
        ? visible.indexOf(triggerFor(current)) : -1;
      var next = visible[(idx + step + visible.length) % visible.length];
      if (!next) return;
      e.preventDefault();
      if (body.classList.contains('detail-open')) open(next.getAttribute('data-open'));
      else next.focus();
    }
  });
}());`;
}
