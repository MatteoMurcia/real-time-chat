import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

test('revokes every tab of one session, rejects its offline reconnect and preserves another session', async ({ page, context, browser }, testInfo) => {
  test.setTimeout(60000);
  const suffix = randomUUID(), email = `revocation-${suffix}@example.test`, password = 'a unique revocation passphrase';
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const signIn = async (target: Page) => {
    await target.goto('/login'); await target.getByLabel('Email address', { exact: true }).fill(email);
    await target.getByLabel('Password', { exact: true }).fill(password);
    await target.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(target.getByText('Live connection established.', { exact: true })).toBeVisible();
  };
  await page.goto('/register');
  await page.getByLabel('Display name', { exact: true }).fill('Revocation Reader');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?registered=1$/); await signIn(page);
  const origin = process.env.E2E_BASE_URL!;
  const csrf = (await (await context.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken;
  const name = `Revocation ${suffix}`;
  const response = await context.request.post('/api/channels', { headers: { origin, 'x-csrf-token': csrf }, data: { name, slug: `revoke-${suffix}` } });
  expect(response.status()).toBe(201);
  const shared = await context.newPage(); shared.on('pageerror', error => errors.push(error.message));
  const offlineContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL, storageState: await context.storageState() });
  const independent = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  try {
    const offline = await offlineContext.newPage(), other = await independent.newPage();
    offline.on('pageerror', error => errors.push(error.message)); other.on('pageerror', error => errors.push(error.message));
    let offlineSocket: WebSocketRoute | undefined;
    await offline.routeWebSocket('**/socket.io/**', socket => { offlineSocket = socket; socket.connectToServer(); });
    await shared.goto('/workspace'); await offline.goto('/workspace'); await signIn(other);
    for (const target of [shared, offline, other]) {
      await expect(target.getByText('Live connection established.', { exact: true })).toBeVisible();
      await target.getByRole('button', { name: `Open chat ${name}`, exact: true }).click();
      await expect(target.getByText('Live conversation ready.', { exact: true })).toBeVisible();
    }
    await other.getByLabel('Message', { exact: true }).fill('Before revocation');
    await other.getByRole('button', { name: 'Send message', exact: true }).click();
    for (const target of [shared, offline]) await expect(target.getByRole('log').locator('[data-message-id]')).toHaveCount(1);
    await shared.getByLabel('Message', { exact: true }).fill('Private draft');
    await expect.poll(() => !!offlineSocket).toBe(true);
    await offlineContext.setOffline(true); await offlineSocket!.close({ code: 1001, reason: 'Test reconnect during logout' });
    await expect(offline.getByText('Connection interrupted. Reconnecting…', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login\?reason=signed-out$/);
    await expect(shared).toHaveURL(/\/login\?reason=expired$/);
    await expect(shared.getByRole('log')).toHaveCount(0); await expect(shared.getByLabel('Message', { exact: true })).toHaveCount(0);
    await offlineContext.setOffline(false);
    await expect(offline).toHaveURL(/\/login\?reason=expired$/, { timeout: 15000 });
    await expect(offline.getByRole('log')).toHaveCount(0);
    expect((await offlineContext.request.get('/api/auth/me')).status()).toBe(401);
    await expect(other.getByText('Live connection established.', { exact: true })).toBeVisible();
    await other.getByLabel('Message', { exact: true }).fill('Other session remains valid');
    await other.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(other.getByRole('log').locator('[data-message-id]')).toHaveCount(2);
    expect((await independent.request.get('/api/auth/me')).status()).toBe(200);
  } finally { await offlineContext.close(); await independent.close(); await shared.close(); }
  expect(errors).toEqual([]);
});
