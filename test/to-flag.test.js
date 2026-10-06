import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/**
 * --to narrows one run to one address.
 *
 * report.notify and config.notify are merged as a UNION between the tracked
 * file and the git-ignored override, deliberately, so that adding somebody in
 * one place can never silently remove the people listed in the other. That
 * means the list cannot be narrowed in configuration at all, and a test run
 * would otherwise mail seven people to check a layout.
 *
 * The flag is read at module scope from process.argv, so the only honest test
 * is to run the real CLI.
 */
const run = (file, extra) => spawnSync(process.execPath, [file, '--dry-run', ...extra], { encoding: 'utf8' });

for (const file of ['src/n8n/report.js', 'src/check.js']) {
  test(`${file}: --to will not accept a flag as an address`, () => {
    // Without the @ check this sends the report to "--force" and reports
    // success, because the webhook accepts whatever it is handed.
    const bad = run(file, ['--to', '--force']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--to needs at least one address/);

    // A bare --to at the end of the line must not fall back to everybody.
    assert.equal(run(file, ['--to']).status, 2);
  });
}

test('a dry run says who it would have mailed', () => {
  // The flag is worth nothing if you cannot confirm it took effect before the
  // real send.
  const narrowed = run('src/n8n/report.js', ['--force', '--to', 'it6@kwgroup.in']);
  assert.match(narrowed.stdout, /would go to it6@kwgroup\.in/);
  assert.doesNotMatch(narrowed.stdout, /would go to .*,/);

  const everybody = run('src/n8n/report.js', ['--force']);
  assert.match(everybody.stdout, /would go to .*,/);
});
