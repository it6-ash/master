# Design System: KW Estate

The single source of truth for the dashboard's visual language. Every value here
is live in `src/render/styles.css`. Change it here, change it there, and rebuild.

## 1. Visual Theme and Atmosphere

A cockpit, not a gallery. This is an operator's tool for someone who already
knows the estate and needs to find one fact fast, so density beats whitespace
and scanning beats storytelling. The atmosphere is a dark control room at night:
near-black surfaces, one confident blue, and colour spent only where it means
something.

**Dials.** Density 8 (cockpit), Variance 3 (predictable and symmetric, because
symmetry is what makes a grid scannable), Motion 3 (restrained). The default
8/6/4 baseline is deliberately overridden: asymmetry and cinematic motion would
fight the job this page does.

**Motion is earned, never decorative.** Exactly one thing animates: edges in a
flow diagram whose state is `live` or `data`, because the dashes moving along the
path *are* the claim that data moves along that path. A broken edge is red,
dashed and completely still, and the stillness is the point. Nothing else on the
page loops, pulses, floats or shimmers.

## 2. Color Palette and Roles

Every categorical colour below passed the six-check validator against this
page's own dark surface, not against a generic one. Re-run it after any change:

```
node scripts/validate_palette.js "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300" \
  --mode dark --surface "#14161c"
```

### Surfaces and ink

- **Page Plane** (`#0e1015`) - the canvas everything sits on. Not pure black.
- **Card Surface** (`#14161c`) - server cards, project cards, charts, drawer.
- **Raised Surface** (`#191c24`) - elements lifted above a card.
- **Sunken Well** (`#101318`) - code blocks, chart tracks, inset panels.
- **Structural Line** (`#232733`) - 1px container borders.
- **Whisper Line** (`#1c2029`) - row dividers inside a container.
- **Primary Ink** (`#f2f3f5`) - values, headings, anything being read.
- **Secondary Ink** (`#a8afbd`) - descriptions, body copy, labels.
- **Muted Ink** (`#6d7585`) - metadata, timestamps, provenance notes.

### Categorical series (fixed order, never cycled)

Used for identity only, when the series *are* the subject.

1. **Signal Blue** (`#3987e5`) - the single accent. Active state, focus rings, links, series 1.
2. **Ember Orange** (`#d95926`) - series 2.
3. **Deep Aqua** (`#199e70`) - series 3.
4. **Amber Ochre** (`#c98500`) - series 4.
5. **Dusty Magenta** (`#d55181`) - series 5.
6. **Forest Green** (`#008300`) - series 6.

Past six, fold the tail into "Other" or facet into small multiples. A seventh
generated hue is banned; it is indistinguishable under CVD.

### Status (reserved, never reused as a series colour)

- **Good** (`#0ca30c`) - running, healthy, reconciled.
- **Warning** (`#fab219`) - partial, stale, degraded.
- **Serious** (`#ec835a`) - high-severity issues.
- **Critical** (`#d03b3b`) - critical issues, failed units, broken paths.
- **Neutral Slate** (`#4a5163`) - idle, inactive, de-emphasised.

A status colour never carries meaning alone. It always ships with a text label
or a glyph beside it: `✕ never runs`, `CRITICAL`, `ufw active`.

### Ordinal ramp (ordered stages only)

`#86b6ef` → `#3987e5` → `#1c5cab`. One hue, light to dark, for funnel stages and
tiers. On this dark surface, never step past `#184f95` or it falls under the 2:1
floor. A rainbow ramp is banned. A value-ramp applied to unordered categories is
banned.

## 3. Typography

- **Display and body:** the system UI sans (`system-ui, -apple-system, "Segoe UI", Roboto`). Hierarchy comes from weight (560/620/650) and ink colour, never from raw scale.
- **Numbers, identifiers, paths, schedules:** `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas`. At density 8 every number is monospace.
- **Tabular figures** only where digits must align vertically: table rows, axis ticks, meter readouts. Never on a large standalone stat value, where equal-width digits make the number look loose.
- **No webfont.** The page must open from `file://` with no network. A CDN link would break that, and embedding a face as base64 would add hundreds of KB to a file whose whole point is portability. The system stack is the honest answer, and it is not Inter.
- **No serif anywhere.** Serif in a dashboard is always wrong.

## 4. Component Behaviour

- **Cards** exist only where elevation carries real hierarchy: a server, a project, a chart, an issue. Inside a card, rows are separated by a single whisper-line divider, never by nested cards.
- **Buttons** are flat. No outer glow, ever. Hover lifts by 1px and warms the border; `:focus-visible` draws a 2px Signal Blue ring at 2px offset.
- **Filter chips** are pill-shaped with `aria-pressed` carrying the state, so the control is real to a screen reader and not just visually shaded.
- **Meters** are a 5px track in the sunken well with a single fill. The fill turns Warning above 80% and Critical above 90%. A meter is the right form for one ratio against a limit; a two-slice pie is not.
- **Charts** are capped at 620px and centred. An SVG with a viewBox scales its text along with its geometry, so an uncapped chart in a wide cell renders 20px axis labels.
- **Flow diagrams** render at natural size inside a horizontally scrolling wrapper. Never scaled to fit: a ten-node chain squeezed into an 800px drawer turns 12px labels into 4px.
- **Empty states** say what is missing and what to do about it. "No changes yet. Every server has exactly one snapshot, so there is nothing to compare against. Run kw-collect.sh again in a few days." Not "No data".
- **Tables** twin every chart, behind a `<details>` disclosure, so no value is reachable only by hovering.

## 5. Shape and Layout

- **One radius scale.** 10px on containers, 6px on controls and inset panels, 999px on pills, 4px on chart data-ends. Nothing else.
- **CSS Grid throughout.** No flexbox percentage arithmetic, no `calc()` width hacks.
- **Auto-fit grids with a real minimum**: servers at 340px, projects at 258px, charts at 400px. Every grid collapses to one column below its minimum without a media query.
- **A grid never ends on a hole.** When an odd chart lands last in a two-column grid it spans both columns and centres its drawing.
- **Content capped at 1280px**, centred, 28px gutters.
- **Cards in a stretched row top-align.** A `<button>` centres its content box by default, which floats shorter cards to the middle of the row; `justify-content: flex-start` pins them level.

## 6. Interaction

- `/` focuses search. `Esc` clears the field, then closes the drawer. Arrow keys walk the project grid, and keep walking inside the drawer once one is open.
- Search filters servers, projects, issues and workflows at once, and auto-opens any workflow group that now contains a match.
- Deep links are real URLs: `#project=yamini`, `#server=srv1340120`. They survive reload, back and forward, and are safe to paste to a colleague.
- Every cross-reference is a link. A workflow in the inventory opens the project that owns it. A project's server pill opens that server. A server's project table links back.
- **Print** drops the whole page except the open drawer, which becomes a clean one-page brief: animation off, table views expanded, flows on white.

## 7. Anti-Patterns (banned)

- No emoji anywhere in the interface.
- No Inter, no serif, no webfont.
- No pure black (`#000000`) or pure white.
- No neon, no outer glow, no gradient text.
- No purple accent, no AI-gradient mesh.
- No dual-axis charts. Two measures of different scale are two charts.
- No cycled or generated categorical hue past slot six.
- No rainbow sequential ramp; no hue at a diverging midpoint.
- No value-ramp on unordered categories.
- No status colour used as a series colour, and no status colour without a label beside it.
- No number printed on every data point. Direct-label selectively; the table view carries the rest.
- No border drawn around marks to separate them. Use a 2px surface gap.
- No tooltip as the only route to a value.
- No decorative status dots. A dot appears only where it encodes real state.
- No scroll cues, no section-number eyebrows, no version stamps, no locale strips.
- No fake-precise numbers. Every figure on this page is either read from an
  ingest or carries a note saying where it came from and when.
