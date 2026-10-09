import { defineConfig } from '@playwright/test';

if (!process.env.E2E_BASE_URL) throw new Error('Set E2E_BASE_URL to an isolated running Compose stack. Tests create accounts.');

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: 0,
  use: { baseURL: process.env.E2E_BASE_URL, browserName: 'chromium', trace: 'off' },
});
