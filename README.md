# kw-estate

A living dashboard for KW Group's infrastructure. Paste a raw dump into `raw/`,
run two commands, get a rebuilt single-file `dist/index.html`.

No server, no database, no polling. It is a build step.

## Build status

Stage order and checkpoints follow the build brief.

| Stage | Deliverable | Status |
|---|---|---|
| 1 | Repo scaffold, `package.json`, schemas, `validate` | **done** |
| 2 | `ingest/vps-dump.js` + tests against real dumps | **done** |
| 3 | `ingest/n8n-list.js`, `mongo-stats.js`, format detection | partial — see below |
| 4 | `diff.js` + auto-issue rules | **done** |
| 5 | Flow DSL auto-layout + animated SVG renderer | **done** |
| 6 | Full HTML build | **done** |
| 7 | Watch mode, `new-project`, README | **done** |

Every command in the brief is live. Beyond the brief: `sync` (collect from all three servers over SSH), `serve`, a dual theme,
a Playwright responsive suite, and a glossary that explains what each thing is
and why it is in the picture.

**On stage 3:** `kw-collect.sh` schema 2.0 already embeds the n8n workflow list
(`===SECTION:N8N===`) and the Mongo collection counts
(`---mongo_collections---`), and `vps-dump.js` parses both. Standalone
`n8n-list.js` / `mongo-stats.js` are still worth having for pasting an export on
its own, but they are no longer on the critical path.

## Hosting it on srv1340120, keeping itself current

The dashboard runs **on** the estate it describes. One command on srv1340120:

```bash
sudo bash deploy/install.sh
```

That is the whole deployment. It clones to `/opt/kw-estate`, generates an SSH
key, installs a systemd timer, and points nginx at the checkout's `dist/`. It is
also the update path — run it again and it takes new code from `origin/main`
without touching the live `data/` and `dist/` on the box.

Four times a day the timer runs `src/sync.js`, which SSHes to all three servers,
runs `kw-collect.sh`, ingests, and rebuilds `dist/index.html` **in place**.
nginx serves that file directly, so there is no copy step and no window where
the page and the data disagree. Nothing new is trusted: the same parser, the
same redaction, the same snapshot-and-diff path a hand-pasted dump takes. A host
that is unreachable is reported and skipped; the others still sync.

```bash
systemctl list-timers kw-estate.timer   # when it next runs
systemctl start kw-estate               # run a pass now
journalctl -u kw-estate -n 50           # what the last pass did
```

srv1340120 collects from **itself over loopback**, not its public IP — no
hairpin, no firewall rule, one code path for all three. The other two need this
box's public key in `root@authorized_keys`; `install.sh` prints it and refuses
to enable the timer until all three answer.

**This page must not be public.** It lists every server's IP and open ports,
which units are failing, which hostnames have no certificate, where credentials
sit in crontabs, and the text of every open security finding. It is a map of
how to attack this estate. The vhost sets HTTP basic auth over TLS, which is the
minimum; putting it behind the Cloudflare tunnel that already serves
kwatch.leadq.co.in and using Cloudflare Access would be better. `install.sh`
will not enable the vhost until an htpasswd file exists.

**What this costs the box it monitors.** One more `server_name` on an nginx that
already terminates several; no new port, no change to any existing server block,
nothing proxied — the other tenants are untouched, and `nginx -T | grep
server_name` before reloading will show you that. The service runs `Nice=15`
with idle I/O, root-only for the SSH key, under `ProtectSystem=strict`. Three
things are pruned so a timer cannot become a disk problem: snapshots to the
newest 60 per server, `raw/` dumps to the newest 5 per host, and the collector's
output on each remote box, deleted as soon as it has been fetched.

Two consequences worth knowing: the dashboard is down exactly when the box it
monitors is down, and `estate.leadq.co.in` will be discovered and listed as a
project by the next collection.

### Running it from somewhere else instead

`npm run sync` works from any machine with SSH to the three servers — a laptop,
a runner, anywhere. `npm run deploy` then ships the built file to a web root.

```bash
npm run sync                # collect from every server, ingest, rebuild
npm run sync -- --every 6h  # keep doing that on an interval
npm run sync -- --dry-run   # print the SSH commands, run nothing
npm run deploy              # build, then scp dist/index.html to the web root
```

Connection details live in `config/hosts.json`, which is **git-ignored**. Copy
`config/hosts.example.json` and fill it in. No password belongs in that file:
use an SSH key or an agent. With no config at all, sync falls back to the IPs
already in `data/servers.json`, so a first run needs nothing but working SSH.

**A note on scope.** The brief was explicit that this is not a monitoring tool
and does not poll servers. Sync is a deliberate departure, added on request. It
needs SSH access to production from wherever it runs, which is a real security
decision and not only a convenience. And a dashboard that refreshes itself is
one nobody reads carefully, so the "What changed" panel matters more once this
is on a timer, not less.

Sync and deploy have been exercised end to end with `--dry-run`, which resolves
all three hosts and prints the exact commands. The live SSH path has **not** been
run against your servers from here, and neither has `install.sh`.

## The collector

`kw-collect.sh` is the read-only estate collector. It emits the
`===SECTION:NAME===` / `---subsection---` format `vps-dump.js` consumes, and
redacts credentials at source before the dump ever leaves the server.

```bash
scp kw-collect.sh root@<server>:/root/
ssh root@<server> 'bash /root/kw-collect.sh'
scp root@<server>:/root/kw-collect-*.txt ./raw/
```

The parser is pinned to collector schema 2.0 and warns if it meets another.

## Commands

```bash
npm run sync                # collect from every server, ingest, rebuild
npm run sync -- --every 6h  # keep doing that on an interval
npm run sync -- --dry-run   # print the SSH commands, run nothing
npm run watch               # rebuild whenever data/ or content/ changes
npm run watch -- --serve    # ... and serve dist/ at the same time
npm run serve               # serve dist/ on http://localhost:4178

npm run validate            # schema-check everything, exit non-zero on error
npm run validate -- --json  # same, machine-readable
npm test                    # unit tests (node:test, no runner dependency)

npm run ingest              # scan raw/, auto-detect format, update data/, snapshot   [stage 2-3]
npm run ingest -- raw/x.txt # ingest one specific file                                [stage 2-3]
npm run diff                # print what changed between the last two snapshots       [stage 4]
npm run build               # data/ + content/ -> dist/index.html                     [stage 6]
npm run watch               # rebuild on any change under data/ or content/           [stage 7]
npm run new-project <slug>  # scaffold content/projects/<slug>.md                     [stage 7]
```

## Layout

```
data/       canonical state, machine-written. servers, workflows, issues, snapshots
content/    project docs — frontmatter contract + prose + flow blocks. Hand-written
raw/        paste drop-zone. Git-ignored, see Secrets
schema/     JSON Schema for every file in data/ and for project frontmatter
src/        ingest parsers, DSL parsers, diff, renderers, build
test/       unit tests; test/fixtures/ holds REDACTED copies of real dumps
dist/       the single-file output
```

## Dependencies

None. Not runtime, not build-time.

The brief permitted `gray-matter` and `marked`. Neither is installed: the
frontmatter subset is small enough to own (`src/lib/yaml-lite.js`), and owning it
buys precise `file:line` errors, which `validate` needs to report malformed
frontmatter usefully. `marked` is still an open question for Stage 6 — say the
word and it goes in, otherwise prose gets a small Markdown subset renderer.

JSON Schema validation is `src/lib/json-schema.js`, a ~300-line subset validator,
rather than ajv.

## Secrets

Secrets have leaked into this estate's configs, crontabs and shell history
repeatedly. Two mechanisms, sharing one pattern table in `src/lib/redact.js`:

- **ingest redacts** every string before it is written to `data/`. The structure
  survives, the value does not — a cron line stays readable as a cron line and
  gains `hasSecret: true`.
- **validate scans** everything in `data/` and fails the build on anything
  credential-shaped.

Because both read the same table, a green `validate` genuinely means "ingest
would have caught everything validate can see". Adding a pattern strengthens both.

Two consequences worth knowing:

- `raw/` is **git-ignored**. Dumps arrive unredacted. Fixtures committed to
  `test/fixtures/` must be redacted copies, not originals.
- Redaction errs toward over-matching. A dashboard tile reading
  `[REDACTED:assigned-secret]` is a nuisance; a token in git history is not.
  Findings printed by `validate` are themselves redacted, so a failure report is
  safe to paste into a chat.

## Data contracts

`schema/*.json` is the source of truth; each file carries `description` fields
explaining where the value comes from.

- `servers.schema.json` — keyed by server id. Everything except `name` is
  optional, deliberately: a truncated dump must never null out a section that
  simply was not present.
- `workflows.schema.json` — keyed by n8n workflow id. `history` records state
  *changes* only, so the dashboard can say "deactivated 3 days ago".
- `issues.schema.json` — `source: manual` entries are never touched by
  machinery; `source: auto` entries name the rule that fired and are regenerated
  on every ingest.
- `snapshot.schema.json` — written before merging, `$ref`s the server record.
  `sourceSha256` is what makes re-ingest idempotent.
- `project-frontmatter.schema.json` — the contract at the top of each project doc.
- `events.schema.json` — change events for the "What changed" panel.

## Project docs

`content/projects/<slug>.md`. Frontmatter is the machine-readable contract, the
body is prose. `id` must equal the filename slug. A ```flow block renders as an
animated SVG; a ```mermaid block renders statically.

Flow DSL, one statement per line:

```
<kind> <id> "<label>" "<sublabel>" [state] [@x,y]
edge <from> -> <to> [state] ["label"]
```

`kind` is `node` · `store` · `ext` · `group`. `state` is `live` · `data` · `idle`
· `broken`, default neutral. `@x,y` overrides auto-layout for that one node.
Comments start with `#`.
