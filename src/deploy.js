#!/usr/bin/env node
/**
 * npm run deploy — build, then copy dist/index.html to the web root.
 *
 *   npm run deploy                to the configured host
 *   npm run deploy -- srv1900820  to a specific one
 *   npm run deploy -- --dry-run   print the commands, run nothing
 *
 * Target host and path come from config/hosts.json (`deploy: { host, path }`),
 * falling back to srv1340120:/var/www/kw-estate, which is the box that already
 * runs nginx and holds the certificates.
 *
 * The vhost, including the basic auth this page requires, is
 * deploy/kw-estate.nginx.conf. Install it once by hand; this script only ever
 * moves one file.
 */

import { spawnSync } from 'node:child_process';

import { abs, exists, readJson } from './lib/fsx.js';
import { loadHosts } from './sync.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const wanted = args.filter((a) => !a.startsWith('--'))[0];

const config = readJson(abs('config', 'hosts.json'));
const deployCfg = config.ok ? (config.value.deploy ?? {}) : {};

const hosts = loadHosts();
const host = hosts.find((h) => h.id === (wanted ?? deployCfg.host ?? 'srv1340120'));

if (!host) {
  process.stderr.write(`No such host. Known: ${hosts.map((h) => h.id).join(', ') || '(none)'}\n`);
  process.exit(2);
}

const remoteDir = deployCfg.path ?? '/var/www/kw-estate';
const target = `${host.user ?? 'root'}@${host.host}`;
const ssh = [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=15',
  ...(host.port ? ['-p', String(host.port)] : []),
  ...(host.key ? ['-i', host.key] : []),
];

const run = (cmd, argv) => {
  if (dryRun) { process.stdout.write(`  would run: ${cmd} ${argv.join(' ')}\n`); return 0; }
  return spawnSync(cmd, argv, { stdio: 'inherit' }).status ?? 1;
};

/* Build first: deploying a stale file defeats the point of the page. */
if (run(process.execPath, [abs('src', 'build.js')]) !== 0) process.exit(1);

const file = abs('dist', 'index.html');
if (!exists(file) && !dryRun) {
  process.stderr.write('dist/index.html is missing. Run npm run build.\n');
  process.exit(1);
}

process.stdout.write(`\ndeploying to ${target}:${remoteDir}\n`);

// scp -O uses the plain protocol; newer OpenSSH defaults to sftp, which fails
// on hosts that have the sftp subsystem disabled.
if (run('ssh', [...ssh, target, `mkdir -p ${remoteDir}`]) !== 0) process.exit(1);
if (run('scp', [...ssh, file, `${target}:${remoteDir}/index.html`]) !== 0) process.exit(1);

process.stdout.write(`
Done. If this is the first deploy, install the vhost too:
  scp deploy/kw-estate.nginx.conf ${target}:/etc/nginx/sites-available/kw-estate
  ssh ${target} 'ln -s /etc/nginx/sites-available/kw-estate /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx'

The vhost sets basic auth. Do not remove it: this page maps every open port,
failed unit and unrotated credential in the estate.
`);
