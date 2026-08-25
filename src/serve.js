#!/usr/bin/env node
/**
 * npm run serve — serve dist/ over http://localhost:4178
 *
 * The dashboard is a single self-contained file and works fine from file://.
 * This exists because deep links (#project=yamini) and history.pushState
 * behave better over http, and because a localhost URL is easier to share
 * with a browser already open.
 *
 * Zero dependencies, loopback-only. Pass --port N to change the port.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, abs, exists } from './lib/fsx.js';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg !== -1 ? Number(args[portArg + 1]) : 4178;
const HOST = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const root = abs('dist');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname.endsWith('/')) pathname += 'index.html';

  // Resolve inside dist/ only — no traversal out of the served root.
  const target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (!exists(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      .end(`Not found: ${pathname}\n\nRun \`npm run build\` first.`);
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(target).pipe(res);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    process.stderr.write(`Port ${PORT} is already in use. Try: npm run serve -- --port ${PORT + 1}\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  if (!exists(abs('dist', 'index.html'))) {
    process.stdout.write('dist/index.html does not exist yet — run `npm run build`.\n');
  }
  process.stdout.write(`\n  KW Estate  →  http://localhost:${PORT}\n\n  serving ${path.relative(ROOT, root) || 'dist'}/ · Ctrl-C to stop\n\n`);
});
