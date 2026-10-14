import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { io } from 'socket.io-client';

test('recovers three missed pages after disconnect and API restart, then retries a failed focus recovery', async ({ page, context }) => {
  test.setTimeout(90000);
  const suffix = randomUUID(), name = `Recovery ${suffix}`, slug = `recovery-${suffix}`;
  const errors: string[] = [], requests: URL[] = [];
  let connection: WebSocketRoute | undefined;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/messages/sync')) requests.push(new URL(request.url())); });
  await page.routeWebSocket('**/socket.io/**', socket => { connection = socket; socket.connectToServer(); });
  await page.goto('/register');
  await page.getByLabel('Display name', { exact: true }).fill('Recovery Reader');
  await page.getByLabel('Email address', { exact: true }).fill(`recovery-${suffix}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a unique recovery passphrase');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?registered=1$/);
  await page.getByLabel('Email address', { exact: true }).fill(`recovery-${suffix}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a unique recovery passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
  const origin = process.env.E2E_BASE_URL!;
  const csrf = (await (await context.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken;
  const response = await context.request.post('/api/channels', { headers: { origin, 'x-csrf-token': csrf }, data: { name, slug } });
  expect(response.status()).toBe(201); const { channel } = await response.json();
  const cookie = (await context.cookies()).find(value => value.name === 'chat_session')!;
  const sender = io(origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { origin, cookie: `${cookie.name}=${cookie.value}` } });
  try {
    await new Promise<void>((resolve, reject) => { sender.once('connect', resolve); sender.once('connect_error', reject); sender.connect(); });
    await page.getByRole('button', { name: 'Refresh channels', exact: true }).click();
    let initialCursor = '';
    // Buffer the real response before forwarding it; Chromium may discard its protocol body.
    await page.route(`**/api/channels/${channel.id}/messages/sync?*`, async route => {
      const response = await route.fetch(); initialCursor = (await response.json()).nextCursor;
      await route.fulfill({ response });
    }, { times: 1 });
    const initialResponse = page.waitForResponse(response => response.url().includes('/messages/sync?') && response.status() === 200);
    await page.getByRole('button', { name: `Open chat ${name}`, exact: true }).click();
    await initialResponse;
    await expect(page.getByText('No messages yet. Say hello.', { exact: true })).toBeVisible();
    await expect(page.getByText('Recovering missed messages…', { exact: true })).toHaveCount(0);
    expect(initialCursor).not.toBe('');
    await expect.poll(() => !!connection).toBe(true);
    await context.setOffline(true); await connection!.close({ code: 1001, reason: 'Test network interruption' });
    await expect(page.getByText('Connection interrupted. Reconnecting…', { exact: true })).toBeVisible();
    await page.getByLabel('Message', { exact: true }).fill('Draft survives recovery');
    const ids: string[] = [];
    for (let i = 1; i <= 105; i++) {
      const ack = await sender.timeout(5000).emitWithAck('message:send', { channelId: channel.id, clientMessageId: randomUUID(), body: `Missed ${i}` });
      expect(ack.ok).toBe(true); ids.push(ack.data.id);
    }
    const project = process.env.E2E_COMPOSE_PROJECT ?? '';
    expect(['ci-chat', 'chat-e2e', 'handshake-verification']).toContain(project);
    const container = `${project}-api-1`;
    expect(execFileSync('docker', ['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', container], { encoding: 'utf8' }).trim()).toBe(project);
    execFileSync('docker', ['restart', '--time', '2', container], { timeout: 20000, stdio: 'pipe' });
    requests.length = 0;
    await context.setOffline(false); await page.bringToFront();
    const rows = page.getByRole('log', { name: 'Conversation messages' }).locator('[data-message-id]');
    await expect(rows).toHaveCount(105, { timeout: 20000 });
    expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id')))).toEqual(ids);
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Draft survives recovery');
    expect(requests[0]?.searchParams.get('after')).toBe(initialCursor);
    const bounded = requests.filter(request => request.searchParams.has('until'));
    expect(bounded).toHaveLength(2);
    expect(bounded[0]!.searchParams.get('until')).toBe(bounded[1]!.searchParams.get('until'));
    await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toHaveCount(0);
    await expect(page.getByText('Recovering missed messages…', { exact: true })).toHaveCount(0);
    await page.route('**/api/channels/*/messages/sync?*', route => route.fulfill({ status: 503, body: '{}' }), { times: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('button', { name: 'Retry recovery', exact: true })).toBeVisible();
    await expect(rows).toHaveCount(105);
    await page.screenshot({ path: 'test-results/recovery-error.png', fullPage: true });
    const retried = page.waitForResponse(response => response.url().includes('/messages/sync?') && response.status() === 200);
    await page.getByRole('button', { name: 'Retry recovery', exact: true }).click();
    await retried;
    await expect(page.getByRole('button', { name: 'Retry recovery', exact: true })).toHaveCount(0);
    await expect(page.getByText('Recovering missed messages…', { exact: true })).toHaveCount(0);
    await expect(rows).toHaveCount(105);
    await page.getByRole('button', { name: 'Close conversation', exact: true }).click();
    await expect(page.getByRole('log', { name: 'Conversation messages' })).toHaveCount(0);
    const count = requests.length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(requests).toHaveLength(count);
  } finally { sender.disconnect(); await context.setOffline(false); }
  expect(errors).toEqual([]);
});
