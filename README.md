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

Four times a day the timer takes new code from `origin/main` and then runs
`src/sync.js`, which SSHes to all three servers, runs `kw-collect.sh`, ingests,
and rebuilds `dist/index.html` **in place**. A push to main is live on the box
within six hours; nothing to run by hand.

`deploy/pull.sh` is that update, and it is the single owner of which paths git
may overwrite here. It never pulls or merges — it checks out named code paths
and leaves `data/` and `dist/` alone, because ingest on this box writes state
newer than anything in the repo. If GitHub is unreachable it says so and the
pass runs on the code already on disk. Unit files are deliberately excluded: a
timer that can rewrite its own systemd unit and restart itself is a bad thing
to debug at 3am, so `deploy/*.service` changes still need `install.sh`.
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

### Who can read it

Live at **https://estate.leadq.co.in**, nginx on srv1340120, Let's Encrypt via
`certbot --nginx`. Deployed with `AUTH=none` at the owner's instruction, so it
is readable by anyone who resolves the hostname.

Know what that means. The page lists every server's IP and open ports, which
units are failing, which hostnames have no certificate, where credentials sit
in crontabs, and the text of every open security finding. It is a map of how to
attack this estate.

```bash
AUTH=basic bash deploy/install.sh   # htpasswd prompt; needs /etc/nginx/.kw-estate-htpasswd
AUTH=none  bash deploy/install.sh   # no auth at all
```

For no prompt without publishing it, keep `AUTH=basic` and swap the two
`auth_basic` lines in the vhost for `allow <your.ip>; deny all;`. Better still,
`MODE=tunnel` puts it behind the cloudflared already serving kwatch.leadq.co.in,
where Cloudflare Access gives named identities and no public port — that needs
an ingress rule and an Access policy, and is worthless without both.

`install.sh` never overwrites a vhost carrying certbot's `ssl_certificate`; it
edits it. Re-running the installer must not silently undo TLS.

**What this costs the box it monitors.** One more `server_name` on an nginx that
already terminates several: no new port, no change to any existing server block,
nothing proxied.

That reasoning was right and still broke a neighbour. The vhost shipped with
`listen [::]:80`; certbot mirrored it to 443; and because no other vhost on that
box listened on IPv6, ours became nginx's IPv6 **default server** — serving its
certificate for every hostname over IPv6. n8n's UI threw certificate warnings,
its ACME renewal failed, and the nightly report stopped, all from one line that
claimed no port and touched no other block. The dimension I checked was not the
dimension that mattered.

So `install.sh` no longer argues, it measures. Before enabling the vhost it
records the certificate every other hostname serves over IPv4 **and** IPv6;
after reloading it looks again; if any of them moved, it removes the vhost,
reloads, and stops. A dashboard is not worth breaking a neighbour for. The service runs `Nice=15`
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

## Checking it from outside

```bash
npm run check                 probe every hostname, submit the forms, report
npm run check -- --no-forms   probe only; write nothing to any CRM
npm run check -- --dry-run    print what it would do, touch nothing
```

Everything else on the dashboard is the estate describing itself — ports it has
open, units it believes are running. This is the one part that fails when DNS
is wrong, a certificate has lapsed, or a lead form quietly stops accepting
submissions. A perfectly healthy box reports none of those.

The hostname list is **derived** from `data/servers.json`, so a site deployed
today is checked today. `*.hstgr.cloud` is dropped (provider-issued, nobody
visits it) and so is a bare `_` catch-all. Results land in `data/checks.json`
and become issues: unreachable is high, over 5s is medium, a broken lead form
is critical — every enquiry through it is being lost, and nothing on the server
says so.

Forms are the opposite of derived. **A form is submitted only if it is listed in
`config/checks.json`**, because each run posts a real lead into a real CRM and
guessing at an endpoint is how you fill someone's pipeline with junk.
Submissions are marked — name `KW Estate monitor`, an undiallable number, and a
plus-addressed email carrying the date — so they filter out in one rule.

Then it checks the lead actually **arrived**. A landing page can accept a
submission, return a cheerful 200 and drop it: a dead webhook, an expired key, a
workflow switched off. Nothing anywhere reports that; enquiries simply stop. So
after posting, `verify` looks the lead up by the one thing unique to it — the
plus-addressed email — polling a few times because a CRM ingests asynchronously.
`{email}`, `{phone}` and `{date}` are substituted into the URL, headers and
body, so it is Cratio today and any other CRM later without a code change.

**No CRM credential lives in this repo or on disk.** `verify` calls n8n over
loopback (`127.0.0.1:5678`), and n8n already holds the Cratio credential in its
own store. The request never leaves the box, and `config/checks.json` contains
nothing worth stealing. `deploy/n8n-kw-estate.json` holds both branches — the report mailer
and the lead lookup — in one workflow, so there is one thing to import,
activate and hang credentials on.

It answers `LEAD_FOUND` or `LEAD_MISSING` rather than echoing the address,
deliberately: a not-found reply containing the email would match the search
string and report every miss as a hit — silent failure in the one check whose
entire job is to catch silent failure.

That produces three distinct findings, because they need three different
reactions:

| What happened | Finding | Severity |
|---|---|---|
| The form rejected the submission | `form-broken` | critical |
| It accepted, the CRM never got it | `lead-not-in-crm` | critical |
| It accepted, the CRM would not answer | `crm-unreachable` | medium |

The middle one is the reason this exists. Everything visible looks perfect —
the page shows a thank-you, nginx is healthy, the box reports nothing — and the
salesperson simply never sees the lead. The last one is deliberately *not*
critical: being unable to see is not proof of loss, and paging someone for an
API outage is how alerts get ignored.

**One digest a day, at 09:30 Asia/Kolkata.** The probes run five times daily
and nobody wants five identical "all healthy" mails — that is how a report
becomes a filter rule and then stops being read. The zone is explicit because
srv1340120 runs Etc/UTC, where a bare `09:30` would mail at 15:00 in Delhi and
the only symptom is post-lunch email.

The exception is a failure that was not in the last report: something that
breaks at 11:00 should not wait until tomorrow morning, so it mails
immediately. `alertOnNewFailures: false` turns that off;
`npm run check -- --force-report` mails now regardless.

**The config is tracked, not git-ignored.** `config/checks.example.json` is the
real configuration and ships with the code, so a form added here starts being
checked on the box by itself. It was git-ignored once, and three landing-page
forms then sat in this repo for days while srv1340120 kept testing two — the
only fix being somebody remembering to copy a file. Nothing in it is secret:
public endpoints, field names, internal addresses, a loopback URL.

`config/checks.json` remains git-ignored and is now an **override** layered on
top: forms merge by id with the local copy winning, so a hand-set `phone` for a
site that validates strictly survives while new forms still arrive. A webhook
token, if you ever need one, belongs there.

The report goes to the n8n on srv1340120 as a JSON POST — subject, summary and
the failures, already shaped for an email node. `notify` takes one address or a
list; the payload carries `to` comma-separated and `toList` as an array, since
email nodes disagree about which they want. `cc` works the same way.

Note what hosting the alerts inside the estate means: n8n is both the thing
delivering them and one of the things being watched, so it cannot tell you it is
down. `config/checks.json` is git-ignored; copy `config/checks.example.json`.

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
- `costs.schema.json` — **hand-maintained.** Prices and renewal dates only; no
  dump reports what an invoice says.

## What it costs

The Analysis section carries a **Recurring cost and renewals** panel, and
hosting stacks into the cost chart as the fixed floor beneath the volume-driven
bars — which is the point being made: WhatsApp scales, the VPS bill does not.

The *list* is derived. Three VPS with their KVM tier read off the vCPU count,
plus every registrable domain nginx answers for, `*.hstgr.cloud` excluded
because those are issued rather than bought. Deploy a new domain and it appears
in the panel by itself on the next collection, marked "not recorded" — which is
the useful answer, because it names a bill nobody is tracking.

The *prices and dates* cannot be derived and live in `data/costs.json`, keyed
`vps:<server-id>` and `domain:<domain>`. Anything else you pay for takes any key
plus a `label`. A blank stays blank: "we don't know what this costs" and "this
is free" are different sentences, and only one of them is true.

```json
"vps:srv1340120": { "provider": "Hostinger", "amount": 1099, "cycle": "monthly", "renewsOn": "2026-11-14" },
"domain:leadq.co.in": { "provider": "GoDaddy", "amount": 899, "cycle": "yearly", "renewsOn": "2027-03-02" }
```

Yearly and quarterly cycles are normalised to a monthly figure for the total.
`npm run validate` schema-checks the file; `npm run build` warns for every line
still unpriced.

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
