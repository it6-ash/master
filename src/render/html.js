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
import { renderFlowSvg } from './flow-svg.js';
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
  return `<div class="changes">${events.slice(0, 20).map((e) => {
    const subject = e.name ?? e.domain ?? (e.port != null ? `port ${e.port}` : '');
    const delta = e.from != null && e.to != null
      ? `<span class="faint">${escapeHtml(String(e.from))} → ${escapeHtml(String(e.to))}</span>`
      : e.days != null ? `<span class="faint">${e.days} days</span>` : '';
    return `<div class="change change--${e.severity ?? 'info'}">
      <div class="change-bar"></div>
      <div class="change-type">${escapeHtml(EVENT_LABELS[e.type] ?? e.type)}</div>
      <div><strong>${escapeHtml(String(subject))}</strong> ${delta}
        ${e.server ? `<span class="faint">on ${escapeHtml(e.server)}</span>` : ''}</div>
      <div class="change-when num">${escapeHtml(e.at ?? '')}</div>
    </div>`;
  }).join('')}</div>`;
}

/* ------------------------------------------------------- server cards */

function renderServerCard(id, server, { issues, history, staleDays, projects, workflows }) {
  const state = server.state ?? {};
  const failed = (server.services ?? []).filter((s) => s.state === 'failed');
  const mine = projects.filter((p) => p.server === id);
  const wf = Object.values(workflows).filter((w) => w.server === id);
  const meterClass = (p) => (p >= 90 ? 'meter-fill--bad' : p >= 80 ? 'meter-fill--warn' : '');

  const alerts = issues.filter((i) => i.server === id && !i.resolved && i.claimStatus !== 'reconciled')
    .sort(bySeverity).slice(0, 3);

  const facts = [
    server.specs?.cpu ? `${server.specs.cpu} vCPU` : null,
    server.specs?.ram ?? null,
    state.uptime ? `up ${state.uptime}` : null,
    `${mine.length} projects`,
    wf.length ? `${wf.length} workflows` : null,
    server.containers?.length ? `${server.containers.length} containers` : null,
  ].filter(Boolean);

  // The left edge carries health, so the state is readable before any text is.
  const health = alerts.some((i) => i.severity === 'critical') ? 'critical'
    : (failed.length || alerts.length) ? 'warning' : 'ok';

  return `<button class="server searchable tilt server--${health}" type="button" data-open="server:${escapeHtml(id)}"
      data-search="${escapeHtml(`${id} ${server.role ?? ''} ${server.ip ?? ''}`.toLowerCase())}">
    <div class="server-head">
      <div>
        <div class="server-name">${escapeHtml(id)}</div>
        <div class="server-role">${escapeHtml(server.role ?? '')}</div>
      </div>
      <div style="text-align:right">
        <div class="server-ip">${escapeHtml(server.ip ?? '')}</div>
        ${staleDays != null && staleDays > 7
    ? `<div class="stale">ingested ${staleDays}d ago</div>`
    : `<div class="faint" style="font:11.5px var(--mono)">${escapeHtml(server.lastIngest?.slice(0, 10) ?? 'never ingested')}</div>`}
      </div>
    </div>

    <div class="meters">
      ${Number.isInteger(state.diskUsedPct) ? `<div class="meter-row">
        <span class="meter-label">disk</span>
        <span class="meter"><span class="meter-fill ${meterClass(state.diskUsedPct)}" style="width:${state.diskUsedPct}%"></span></span>
        <span class="meter-value">${state.diskUsedPct}% · ${escapeHtml(state.diskUsed ?? '')}</span>
      </div>` : ''}
      ${Number.isInteger(state.memUsedPct) ? `<div class="meter-row">
        <span class="meter-label">memory</span>
        <span class="meter"><span class="meter-fill ${meterClass(state.memUsedPct)}" style="width:${state.memUsedPct}%"></span></span>
        <span class="meter-value">${state.memUsedPct}% · ${escapeHtml(state.memUsed ?? '')}</span>
      </div>` : ''}
      ${history.disk?.length ? `<div class="meter-row">
        <span class="meter-label">history</span>${sparkline(history.disk)}
        <span class="meter-value">${history.disk.length} snap${history.disk.length === 1 ? '' : 's'}</span>
      </div>` : ''}
    </div>

    <div class="facts">
      ${facts.map((f) => `<span class="pill">${escapeHtml(f)}</span>`).join('')}
      <span class="pill${state.firewall === 'active' ? '' : ' pill--accent'}">
        <span class="dot dot--${state.firewall === 'active' ? 'live' : 'broken'}"></span>ufw ${escapeHtml(state.firewall ?? 'unknown')}</span>
      ${failed.length ? `<span class="pill" style="border-color:${'var(--critical)'};color:var(--critical)">
        <span class="dot dot--broken"></span>${failed.length} failed</span>` : ''}
    </div>

    ${alerts.length ? `<div class="server-alerts">${alerts.map((i) => `<div class="server-alert">
      <span class="sev sev--${i.severity}">${i.severity}</span><span>${escapeHtml(i.title)}</span>
    </div>`).join('')}</div>` : ''}
  </button>`;
}

/* ------------------------------------------------------ server drawer */

function renderServerPanel(id, server, { projects, workflows, issues }) {
  const state = server.state ?? {};
  const mine = projects.filter((p) => p.server === id);
  const wf = Object.values(workflows).filter((w) => w.server === id);
  const activeWf = wf.filter((w) => w.active);
  const mineIssues = issues.filter((i) => i.server === id && !i.resolved).sort(bySeverity);

  // data-label carries the header down to narrow viewports, where the table
  // restacks into one labelled card per row.
  const table = (headers, rows) => (rows.length ? `<div class="table-wrap"><table>
    <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td data-label="${escapeHtml(headers[i] ?? '')}">${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>` : '<p class="faint">Nothing recorded.</p>');

  const exposed = (server.ports ?? []).filter((p) => p.exposed);

  return `<section class="drawer-panel" data-panel="server:${escapeHtml(id)}">
    <dl class="kv">
      <dt>Address</dt><dd>${escapeHtml(server.ip ?? 'unknown')}</dd>
      <dt>Role</dt><dd>${escapeHtml(server.role ?? '')}</dd>
      <dt>OS</dt><dd>${escapeHtml(state.os ?? '')} · ${escapeHtml(state.kernel ?? '')}</dd>
      <dt>Hardware</dt><dd>${server.specs?.cpu ?? '?'} vCPU · ${escapeHtml(server.specs?.cpuModel ?? '')} · ${escapeHtml(server.specs?.ram ?? '')} · ${escapeHtml(server.specs?.disk ?? '')}</dd>
      <dt>Uptime</dt><dd>${escapeHtml(state.uptime ?? '')}${state.rebootPending ? ' · reboot pending' : ''}</dd>
      <dt>Firewall</dt><dd>${escapeHtml(state.firewall ?? 'unknown')} · ${escapeHtml(state.firewallDefault ?? '')}</dd>
      ${server.lastIngest ? `<dt>Last ingest</dt><dd>${escapeHtml(server.lastIngest)}</dd>` : ''}
    </dl>

    ${mineIssues.length ? `<h2>Issues · ${mineIssues.length}</h2>
      ${mineIssues.map(renderIssue).join('')}` : ''}

    <h2>Projects · ${mine.length}</h2>
    ${table(['Project', 'Status', 'Backend', 'Port'], mine.map((p) => [
    `<a href="#project=${escapeHtml(p.id)}" data-open="project:${escapeHtml(p.id)}">${escapeHtml(p.name)}</a>`,
    `<span class="dot dot--${p.status}"></span> ${escapeHtml(p.status)}`,
    escapeHtml((p.services ?? []).join(', ') || '—'),
    p.discovered?.port ? `<span class="num">${p.discovered.port}</span>` : '—',
  ]))}

    <h2>Workflows · ${activeWf.length} active of ${wf.length}</h2>
    ${wf.length ? `<div class="wf-list" style="border:1px solid var(--line);border-radius:var(--r-sm)">
      ${wf.filter((w) => !w.noise).sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name))
    .map((w) => `<div class="wf"><span class="dot dot--${w.active ? 'live' : 'idle'}"></span>
        <span class="wf-name">${escapeHtml(w.name)}</span>
        <span class="wf-id">${escapeHtml(w.group ?? '')}</span></div>`).join('')}
    </div>
    <p class="faint" style="margin-top:8px">${wf.filter((w) => w.noise).length} template imports hidden.</p>` : '<p class="faint">No n8n instance on this host.</p>'}

    <h2>Exposed ports · ${exposed.length}</h2>
    ${table(['Port', 'Bind', 'Process'], exposed.map((p) => [
    `<span class="num">${p.port}/${escapeHtml(p.proto ?? 'tcp')}</span>`,
    `<code>${escapeHtml(p.bind ?? '')}</code>`,
    escapeHtml(p.proc ?? '—'),
  ]))}

    <h2>Hostnames · ${(server.vhosts ?? []).length}</h2>
    ${table(['Domain', 'Upstream', 'Cert'], (server.vhosts ?? []).map((v) => [
    escapeHtml(v.domain),
    v.proxyTo ? `<code>${escapeHtml(v.proxyTo)}</code>` : v.root ? `static ${escapeHtml(v.root)}` : '—',
    v.certExpiryDays != null
      ? `<span class="num" style="color:${v.certExpiryDays < 30 ? 'var(--serious)' : 'inherit'}">${v.certExpiryDays}d</span>`
      : '<span class="faint">none</span>',
  ]))}

    <h2>Containers · ${(server.containers ?? []).length}</h2>
    ${table(['Name', 'State', 'Image', 'Age'], (server.containers ?? []).map((c) => [
    escapeHtml(c.name),
    `<span class="dot dot--${c.state === 'running' ? 'live' : c.state === 'restarting' ? 'broken' : 'idle'}"></span> ${escapeHtml(c.state)}`,
    `<code>${escapeHtml(c.image ?? '')}</code>`,
    c.ageDays != null ? `<span class="num">${c.ageDays}d</span>` : '—',
  ]))}

    <h2>Scheduled jobs · ${(server.cron ?? []).length}</h2>
    ${table(['When', 'User', 'Command'], (server.cron ?? []).slice(0, 40).map((c) => [
    `<code>${escapeHtml(c.schedule ?? '')}</code>`,
    escapeHtml(c.user ?? '—'),
    `${c.hasSecret ? '<span class="sev sev--high">secret</span> ' : ''}<code>${escapeHtml((c.cmd ?? '').slice(0, 90))}</code>`,
  ]))}
  </section>`;
}

/* ------------------------------------------------------ project cards */

function renderProjectCard(project) {
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
      ${project.origin === 'documented' ? '<span class="doc-flag">documented</span>' : ''}
      ${(project.tags ?? []).slice(0, 4).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
    </div>
  </button>`;
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
      ${issue.server ? `<span class="faint" style="font:11px var(--mono)">${escapeHtml(issue.server)}</span>` : ''}
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

function renderProjectPanel(project, { issues, workflows, servers, allProjects }) {
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
      const opts = { id: `f-${project.id}-${flowSeq}`, title: `${project.name} flow` };
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
      <td data-label="Workflow">${escapeHtml(wf.name)}</td>
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
      ${(project.tags ?? []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
    </div>

    ${project.stats?.length ? `<div class="stats" style="margin-bottom:18px;gap:24px">${project.stats.map((s) => `<div>
      <div class="stat-value${s.state ? ` stat-value--${s.state}` : ''}" style="font-size:20px">${escapeHtml(String(s.value))}</div>
      <div class="stat-label">${escapeHtml(s.label)}${s.ref ? ` <span class="faint">· live</span>` : ''}</div>
    </div>`).join('')}</div>` : ''}

    ${lead}
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

    ${connections ? `<h2>Connected to</h2>${connections}` : ''}

    ${mine.length ? `<h2>Issues · ${mine.length}</h2>${mine.map(renderIssue).join('')}` : ''}
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
    const serverWf = Object.values(workflows).filter((w) => w.server === id);
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
    const wf = (p.workflows ?? []).map((w) => workflows[w]).filter(Boolean);
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
              <span class="tree-name">${escapeHtml(w.name)}</span>
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
        <span class="wf-name">${own
    ? `<a href="#project=${escapeHtml(own.id)}" data-open="project:${escapeHtml(own.id)}">${escapeHtml(w.name)}</a>`
    : escapeHtml(w.name)}</span>
        ${w.server ? `<span class="wf-id">${escapeHtml(w.server)}</span>` : ''}
        <span class="wf-id">${escapeHtml(w.id)}</span>
      </div>`;
    }).join('')}</div>
    </details>`;
  }).join('');
}

/* --------------------------------------------------------------- page */

export function renderPage({
  servers, projects, workflows, issues, events, history, staleness, analysis, css, builtAt,
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

<main class="wrap">
  ${renderTiles({ servers, projects, workflows, issues, history })}

  <h2 class="section">What changed</h2>
  ${renderChanges(events)}

  <h2 class="section">Servers <span class="count">${serverIds.length}</span></h2>
  <div class="servers">
    ${serverIds.map((id) => renderServerCard(id, servers[id], {
    issues: openIssues, history: history[id] ?? { disk: [] }, staleDays: staleness[id], projects, workflows,
  })).join('')}
  </div>

  <h2 class="section">Analysis</h2>
  <div class="chart-grid">
    ${analysis.funnel ? funnelChart(analysis.funnel.stages, { title: analysis.funnel.title, id: 'funnel' }) : ''}
    ${workflowChart(wfGroups, { title: 'Workflows by group, template imports excluded', id: 'wf-chart' })}
    ${analysis.costScenarios ? costChart(analysis.costScenarios.rows, { title: analysis.costScenarios.title, id: 'cost' }) : ''}
  </div>

  <h2 class="section">Estate tree <span class="count">server → project → workflow</span></h2>
  ${renderTree(servers, projects, workflows)}

  <h2 class="section">Projects <span class="count">${projects.length} across ${serverIds.length} servers</span></h2>
  <div class="filter-row" id="project-filters">
    <button class="chip" type="button" data-filter="all" aria-pressed="true">All</button>
    ${serverIds.map((id) => `<button class="chip" type="button" data-filter="${escapeHtml(id)}" aria-pressed="false">${escapeHtml(id)}</button>`).join('')}
    <button class="chip" type="button" data-filter="documented" aria-pressed="false">Documented</button>
    <button class="chip" type="button" data-filter="broken" aria-pressed="false">Not healthy</button>
  </div>
  <div class="projects" id="projects">
    ${projects.map(renderProjectCard).join('')}
  </div>

  <h2 class="section">Issues
    <span class="count">${openIssues.filter((i) => i.claimStatus !== 'reconciled').length} open${reconciled.length ? ` · ${reconciled.length} reconciled` : ''}</span>
  </h2>
  ${globalIssues.length ? globalIssues.map(renderIssue).join('') : '<div class="changes"><div class="empty">No estate-wide issues.</div></div>'}

  <h2 class="section">Workflow inventory
    <span class="count">${Object.values(workflows).filter((w) => w.active).length} active of ${Object.keys(workflows).length}</span>
  </h2>
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
    ${projects.map((p) => renderProjectPanel(p, { issues, workflows, servers, allProjects: projects })).join('')}
    ${serverIds.map((id) => renderServerPanel(id, servers[id], { projects, workflows, issues: openIssues })).join('')}
  </div>
</section>

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
    } else {
      titleEl.textContent = id;
      subEl.textContent = '';
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
    var m = /^#(project|server)=(.+)$/.exec(location.hash);
    if (m) open(m[1] + ':' + decodeURIComponent(m[2]), push);
    else if (current) close();
  }
  window.addEventListener('hashchange', function () { fromHash(false); });
  fromHash(false);

  // --- search ---------------------------------------------------------
  var searchables = [].slice.call(document.querySelectorAll('.searchable'));
  function applySearch() {
    var q = search.value.trim().toLowerCase();
    body.classList.toggle('searching', q.length > 0);
    for (var i = 0; i < searchables.length; i++) {
      var el = searchables[i];
      if (!q) { el.classList.remove('no-match'); continue; }
      var hay = el.getAttribute('data-search') || el.textContent.toLowerCase();
      el.classList.toggle('no-match', hay.indexOf(q) === -1);
    }
    // Open any workflow group that now contains a match.
    var groups = document.querySelectorAll('.wf-group');
    for (var g = 0; g < groups.length; g++) {
      if (!q) continue;
      groups[g].open = !!groups[g].querySelector('.wf.searchable:not(.no-match)');
    }
  }
  search.addEventListener('input', applySearch);

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
      if (document.activeElement === search) { search.value = ''; applySearch(); search.blur(); return; }
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
