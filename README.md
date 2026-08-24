# kw-estate

A living dashboard for KW Group's infrastructure. Paste a raw dump into `raw/`,
run two commands, get a rebuilt single-file `dist/index.html`.

No server, no database, no polling. It is a build step.

## Build status

Stage order and checkpoints follow the build brief.

| Stage | Deliverable | Status |
|---|---|---|
| 1 | Repo scaffold, `package.json`, schemas, `validate` | **done** |
| 2 | `ingest/vps-dump.js` + tests against real dumps | blocked — needs the dumps |
| 3 | `ingest/n8n-list.js`, `mongo-stats.js`, format detection | blocked — needs the exports |
| 4 | `diff.js` + auto-issue rules | not started |
| 5 | Flow DSL auto-layout + animated SVG renderer | parser done, layout/render not started |
| 6 | Full HTML build | not started |
| 7 | Watch mode, `new-project`, README | not started |

`npm run ingest`, `build`, `watch`, `diff` and `new-project` exist as commands
but exit 2 with a note until their stage lands. `npm run validate` and
`npm test` are live now.

## Commands

```bash
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
