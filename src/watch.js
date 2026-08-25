#!/usr/bin/env node
/**
 * npm run watch — rebuild whenever data/ or content/ changes.
 *
 *   npm run watch              rebuild on change
 *   npm run watch -- --serve   rebuild on change and serve dist/ too
 *
 * Editing a project doc and seeing the page update is the loop this whole
 * project exists to shorten, so the watcher covers content/ and data/ and
 * nothing else. Changing a renderer means restarting it; that is deliberate,
 * because a half-written module rebuilding on every keystroke is noise.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, abs, rel, exists } from './lib/fsx.js';

const args = process.argv.slice(2);
const alsoServe = args.includes('--serve');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (color ? `[${c}m${s}[0m` : s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const dim = (s) => paint('2', s);

const WATCHED = ['data', 'content'];
const DEBOUNCE = 120;

let timer = null;
let building = false;
let queued = false;

function build(reason) {
  if (building) { queued = true; return; }
  building = true;

  const child = spawn(process.execPath, [abs('src', 'build.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  child.on('close', (code) => {
    building = false;
    const stamp = dim(new Date().toTimeString().slice(0, 8));
    if (code === 0) {
      const summary = out.split('\n').find((l) => l.startsWith('built')) ?? 'built';
      process.stdout.write(`${stamp} ${green('✓')} ${summary.trim()}  ${dim(reason)}\n`);
      for (const line of out.split('\n').filter((l) => l.includes('warn'))) {
        process.stdout.write(`${dim(`         ${line.trim()}`)}\n`);
      }
    } else {
      process.stdout.write(`${stamp} ${red('✗')} build failed\n${out}\n`);
    }
    if (queued) { queued = false; build('queued change'); }
  });
}

function schedule(reason) {
  clearTimeout(timer);
  timer = setTimeout(() => build(reason), DEBOUNCE);
}

/* ------------------------------------------------------------------ main */

for (const dir of WATCHED) {
  const target = abs(dir);
  if (!exists(target)) continue;
  fs.watch(target, { recursive: true }, (event, file) => {
    if (!file) return;
    const name = String(file);
    // dist/ is an output and snapshots are written by ingest, not by hand.
    if (name.endsWith('~') || name.startsWith('.')) return;
    schedule(`${rel(path.join(target, name))} ${event}`);
  });
  process.stdout.write(`${dim(`watching ${dir}/`)}\n`);
}

if (alsoServe) {
  spawn(process.execPath, [abs('src', 'serve.js')], { stdio: 'inherit' });
}

build('initial');
process.stdout.write(`${dim('Ctrl-C to stop.')}\n`);

process.on('SIGINT', () => { process.stdout.write('\nStopped.\n'); process.exit(0); });
