import { defineConfig, devices } from '@playwright/test';

/**
 * The dashboard is a single self-contained file, so the tests load it straight
 * from disk over file:// — no dev server, no ports, nothing to start. That is
 * also the closest match to how it actually gets opened.
 */
export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.js',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
