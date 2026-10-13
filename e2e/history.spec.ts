import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { io } from 'socket.io-client';

test('loads three history pages, merges live traffic, retries errors and clears revoked history', async ({ page, context }) => {
  test.setTimeout(60000);
  const suffix = randomUUID(), name = `History ${suffix}`, slug = `history-${suffix}`;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/register');
  await page.getByLabel('Display name', { exact: true }).fill('History Reader');
  await page.getByLabel('Email address', { exact: true }).fill(`history-${suffix}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a unique history passphrase');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?registered=1$/);
  await page.getByLabel('Email address', { exact: true }).fill(`history-${suffix}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a unique history passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
  const origin = process.env.E2E_BASE_URL!;
  const csrf = (await (await context.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken;
  const headers = { origin, 'x-csrf-token': csrf };
  const response = await context.request.post('/api/channels', { headers, data: { name, slug } });
  expect(response.status()).toBe(201); const { channel } = await response.json();
  const cookie = (await context.cookies()).find(value => value.name === 'chat_session')!;
  const socket = io(origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { origin, cookie: `${cookie.name}=${cookie.value}` } });
  const send = async (body: string) => {
    const ack = await socket.timeout(5000).emitWithAck('message:send', { channelId: channel.id, clientMessageId: randomUUID(), body });
    expect(ack.ok).toBe(true); return ack.data;
  };
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    for (let i = 1; i <= 105; i++) await send(`Saved message ${i}`);
    await page.getByRole('button', { name: 'Refresh channels', exact: true }).click();
    await page.route(/\/api\/channels\/[^/]+\/messages(?:\?.*)?$/, route => route.fulfill({ status: 503, body: '{}' }), { times: 1 });
    await page.getByRole('button', { name: `Open chat ${name}`, exact: true }).click();
    await expect(page.getByText('History could not be loaded. Try again.', { exact: true })).toBeVisible();
    await page.route(/\/api\/channels\/[^/]+\/messages(?:\?.*)?$/, async route => {
      const snapshot = await route.fetch();
      await send('Live while snapshot is in flight');
      await route.fulfill({ response: snapshot });
    }, { times: 1 });
    await page.getByRole('button', { name: 'Retry history', exact: true }).click();
    const rows = page.getByRole('log', { name: 'Conversation messages' }).locator('article');
    await expect(rows).toHaveCount(51);
    await expect(rows.first()).toContainText('Saved message 56');
    await expect(rows.last()).toContainText('Live while snapshot is in flight');
    await page.route(/\/api\/channels\/[^/]+\/messages(?:\?.*)?$/, route => route.abort('failed'), { times: 1 });
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry history', exact: true })).toBeEnabled();
    await expect(rows).toHaveCount(51);
    await page.getByRole('button', { name: 'Retry history', exact: true }).click();
    await expect(rows).toHaveCount(101);
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
    await expect(rows).toHaveCount(106);
    await expect(rows.first()).toContainText('Saved message 1');
    await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toHaveCount(0);
    const ids = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id')));
    expect(new Set(ids).size).toBe(106);
    await page.reload();
    await page.getByRole('button', { name: `Open chat ${name}`, exact: true }).click();
    await expect(rows).toHaveCount(50);
    await expect(rows.last()).toHaveAttribute('data-message-id', ids[105]!);
    expect((await context.request.delete(`/api/channels/${channel.id}/membership`, { headers })).status()).toBe(200);
    await expect(page.getByText('Access to this conversation ended. Refresh channels or sign in again.', { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toHaveCount(0);
  } finally { socket.disconnect(); }
  expect(errors).toEqual([]);
});
