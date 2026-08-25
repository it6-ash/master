#!/usr/bin/env node
/**
 * npm run new-project <slug> — scaffold content/projects/<slug>.md
 *
 * If the slug matches a project already discovered from a server dump, the
 * frontmatter is pre-filled from what was found there. Documenting something
 * should not mean retyping facts the ingest already knows.
 */

import path from 'node:path';
import { ROOT, abs, rel, exists, readJson, writeTextIfChanged } from './lib/fsx.js';

const slug = process.argv[2];

if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  process.stderr.write('usage: npm run new-project <slug>   (lowercase, digits and dashes)\n');
  process.exit(2);
}

const file = abs('content', 'projects', `${slug}.md`);
if (exists(file)) {
  process.stderr.write(`${rel(file)} already exists.\n`);
  process.exit(1);
}

const derived = readJson(abs('data', 'projects.json'));
const known = derived.ok ? derived.value[slug] : null;
const d = known?.discovered ?? {};

const yaml = [
  '---',
  `id: ${slug}`,
  `name: ${known?.name ?? slug}`,
  `server: ${known?.server ?? 'srv1340120'}`,
  `status: ${known?.status ?? 'idle'}`,
  `url: ${known?.url ?? ''}`,
  'tags: []',
  'summary: One sentence. What it does, for whom.',
  ...(known?.services?.length ? [`services: [${known.services.join(', ')}]`] : ['services: []']),
  'workflows: []',
  `updated: ${new Date().toISOString().slice(0, 10)}`,
  '---',
].join('\n');

const found = [
  d.hostnames?.length ? `answers ${d.hostnames.join(', ')}` : null,
  d.backend ? `runs as \`${d.backend}\`${d.port ? ` on port ${d.port}` : ''}` : null,
  d.directory ? `code in \`${d.directory}\`` : null,
].filter(Boolean);

const body = `
${known ? `> Discovered from ${known.server}: ${found.join('; ')}.\n> Delete this line once the prose below says it better.\n` : ''}
## Flow

\`\`\`flow
node  in   "Where it starts"  "source"        live
node  app  "${known?.name ?? slug}"  "${d.port ? `:${d.port}` : 'the thing'}"  live
store db   "Where it lands"   "datastore"

edge in  -> app  live
edge app -> db   data
\`\`\`

## What it is

Each \`##\` heading becomes a numbered panel on the project page.

## Open questions

What nobody has checked yet.
`;

writeTextIfChanged(file, `${yaml}\n${body}`);

process.stdout.write(`${rel(file)}\n`);
if (known) process.stdout.write(`  pre-filled from the last ingest of ${known.server}\n`);
process.stdout.write('  npm run build\n');
