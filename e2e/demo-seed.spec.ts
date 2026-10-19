import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, test, type Page } from '@playwright/test';

test('both seeded accounts sign in and browse the same paginated demonstration history', async ({ browser, page }) => {
  const project = process.env.E2E_COMPOSE_PROJECT ?? '', envFile = process.env.E2E_COMPOSE_ENV_FILE ?? '';
  expect(['ci-chat', 'chat-e2e', 'handshake-verification']).toContain(project); expect(envFile).not.toBe('');
  const owner = execFileSync('docker', ['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', `${project}-api-1`], { encoding: 'utf8', timeout: 10000 }).trim();
  expect(owner).toBe(project);
  const credentials = parseEnv(readFileSync(envFile, 'utf8'));
  const second = await browser.newContext({ baseURL: process.env.E2E_BASE_URL! });
  const bob = await second.newPage();
  const signIn = async (target: Page, name: 'alice' | 'bob') => {
    const password = credentials[name === 'alice' ? 'DEMO_ALICE_PASSWORD' : 'DEMO_BOB_PASSWORD'];
    expect(password?.length ?? 0).toBeGreaterThanOrEqual(15);
    await target.goto('/login');
    await target.getByLabel('Email address', { exact: true }).fill(`${name}@demo.example.test`);
    await target.getByLabel('Password', { exact: true }).fill(password!);
    await target.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(target.getByText('Live connection established.', { exact: true })).toBeVisible();
    await target.getByRole('button', { name: 'Open chat Demo Lounge', exact: true }).click();
    await expect(target.getByRole('log').locator('[data-message-id]')).toHaveCount(50);
  };
  try {
    await signIn(page, 'alice'); await signIn(bob, 'bob');
    const aliceCookie = (await page.context().cookies()).find(cookie => cookie.name === 'chat_session')!;
    const bobCookie = (await second.cookies()).find(cookie => cookie.name === 'chat_session')!;
    expect(aliceCookie.value !== bobCookie.value).toBe(true);
    const rows = page.getByRole('log').locator('[data-message-id]');
    for (const count of [100, 105]) {
      await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
      await expect(rows).toHaveCount(count);
    }
    await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toHaveCount(0);
    expect(await rows.evaluateAll(elements => new Set(elements.map(element => element.getAttribute('data-message-id'))).size)).toBe(105);
    await bob.getByRole('button', { name: 'Open chat Demo Planning', exact: true }).click();
    await expect(bob.getByRole('log').locator('[data-message-id]')).toHaveCount(6);
    await expect(rows).toHaveCount(105);
  } finally { await second.close(); }
});
