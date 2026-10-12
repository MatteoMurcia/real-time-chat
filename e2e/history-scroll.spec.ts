import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { io } from 'socket.io-client';

for (const width of [1280, 390]) {
  test(`preserves reading across pages, live messages and recoverable errors at ${width}px`, async ({ page, context }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 1800 });
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
      for (let i = 1; i <= 105; i++) await send(`Saved message ${i}\n${'Variable height line\n'.repeat(i % 7)}`);
      await page.getByRole('button', { name: 'Refresh channels', exact: true }).click();
      await page.getByRole('button', { name: `Open chat ${name}`, exact: true }).click();
      const log = page.getByRole('log', { name: 'Conversation messages' }), rows = log.locator('article');
      await expect(rows).toHaveCount(50);
      const distanceToBottom = () => log.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
      await expect.poll(distanceToBottom).toBeLessThan(2);
      await log.evaluate(element => { element.scrollTop = 340; element.dispatchEvent(new Event('scroll')); });
      const anchor = async () => log.evaluate(element => {
        const row = Array.from(element.querySelectorAll('article')).find(row => row.getBoundingClientRect().bottom > element.getBoundingClientRect().top)!;
        return { id: row.getAttribute('data-message-id'), top: row.getBoundingClientRect().top };
      });
      const initial = await anchor();
      const expectAnchor = async (expected: Awaited<ReturnType<typeof anchor>>) => {
        await expect.poll(async () => (await anchor()).id).toBe(expected.id);
        await expect.poll(async () => Math.abs((await anchor()).top - expected.top)).toBeLessThan(2);
      };
      await send('New while reading');
      await expect(rows).toHaveCount(51);
      await expect(page.getByRole('button', { name: 'New messages — show latest', exact: true })).toBeVisible();
      await expectAnchor(initial);
      await page.route('**/api/channels/*/messages*', route => route.abort('failed'), { times: 1 });
      await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Retry history', exact: true })).toBeEnabled();
      await expectAnchor(initial);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      await page.route('**/api/channels/*/messages*', async route => {
        const response = await route.fetch(); await held; await route.fulfill({ response });
      }, { times: 1 });
      await page.getByRole('button', { name: 'Retry history', exact: true }).click();
      await expect(page.getByText('Loading history…', { exact: true })).toBeVisible();
      // The anchor follows the reader, not the position at request time.
      await log.evaluate(element => { element.scrollTop += 230; element.dispatchEvent(new Event('scroll')); });
      const moved = await anchor();
      await send('New during pagination');
      await expect(rows).toHaveCount(52);
      release();
      await expect(rows).toHaveCount(102);
      await expectAnchor(moved);
      await expect(log).toBeFocused();
      await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
      await expect(rows).toHaveCount(107);
      await expectAnchor(moved);
      await expect(log).toBeFocused();
      await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'New messages — show latest', exact: true }).click();
      await expect.poll(distanceToBottom).toBeLessThan(2);
      await expect(page.getByRole('button', { name: 'Scroll to latest message', exact: true })).toBeVisible();
      await send('Follow at the bottom');
      await expect(rows).toHaveCount(108);
      await expect.poll(distanceToBottom).toBeLessThan(2);
      await log.evaluate(element => { element.scrollTop = 340; element.dispatchEvent(new Event('scroll')); });
      await send('Unread before closing');
      await expect(page.getByRole('button', { name: 'New messages — show latest', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Close conversation', exact: true }).click();
      await page.getByRole('button', { name: `Open chat ${name}`, exact: true }).click();
      await expect(rows).toHaveCount(50);
      await expect.poll(distanceToBottom).toBeLessThan(2);
      await expect(page.getByRole('button', { name: 'Scroll to latest message', exact: true })).toBeVisible();
      await log.evaluate(element => { element.scrollTop = 340; element.dispatchEvent(new Event('scroll')); });
      const reopened = await anchor();
      await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
      await expect(rows).toHaveCount(100);
      await expectAnchor(reopened);
      await expect(page.getByRole('button', { name: 'Show latest messages', exact: true })).toBeVisible();
      await page.screenshot({ path: `test-results/history-scroll-${width}.png`, fullPage: true });
    } finally { socket.disconnect(); }
    expect(errors).toEqual([]);
  });
}
