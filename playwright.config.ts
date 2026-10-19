import { defineConfig } from '@playwright/test';

if (!process.env.E2E_BASE_URL) throw new Error('Set E2E_BASE_URL to an isolated running Compose stack. Tests create accounts.');

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: 0,
  outputDir: 'test-results/critical',
  reporter: [['line'], ['html', { outputFolder: 'playwright-report/critical', open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL, browserName: 'chromium',
    trace: { mode: 'retain-on-failure', sources: false }, screenshot: 'only-on-failure',
  },
});
