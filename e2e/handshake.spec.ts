import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('authenticates through the proxy and reconnects after the isolated API restarts', async ({ page, context }) => {
  test.setTimeout(90000);
  const project = process.env.E2E_COMPOSE_PROJECT ?? '';
  expect(['ci-chat', 'chat-e2e', 'handshake-verification']).toContain(project);
  const container = `${project}-api-1`;
  const owner = execFileSync('docker', ['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', container], { encoding: 'utf8' }).trim();
  expect(owner).toBe(project);
  let connections = 0;
  page.on('websocket', socket => {
    if (socket.url().includes('/socket.io/')) socket.on('framereceived', ({ payload }) => {
      if (String(payload) === '3probe' || String(payload).startsWith('40')) connections++;
    });
  });
  const email = `handshake-${randomUUID()}@example.test`;
  const password = 'a unique handshake passphrase';
  await page.goto('/register');
  await page.getByLabel('Display name', { exact: true }).fill('Handshake Browser');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?registered=1$/);
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
  await expect.poll(() => connections).toBeGreaterThan(0);
  const cookie = (await context.cookies()).find(item => item.name === 'chat_session')!;
  expect(cookie.httpOnly).toBe(true);
  const beforeRestart = connections;
  try {
    execFileSync('docker', ['stop', '--time', '2', container], { timeout: 15000, stdio: 'pipe' });
    await expect(page.getByText('Connection interrupted. Reconnecting…', { exact: true })).toBeVisible();
  } finally {
    execFileSync('docker', ['start', container], { timeout: 15000, stdio: 'pipe' });
  }
  await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible({ timeout: 30000 });
  await expect.poll(() => connections).toBeGreaterThan(beforeRestart);
  expect((await context.cookies()).find(item => item.name === 'chat_session')?.value).toBe(cookie.value);
  await page.reload();
  await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?reason=signed-out$/);
  expect(await page.evaluate(() => [document.cookie, localStorage.length, sessionStorage.length])).toEqual(['', 0, 0]);
});
