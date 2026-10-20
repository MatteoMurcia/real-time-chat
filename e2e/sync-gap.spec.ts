import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { io } from 'socket.io-client';
import type { MessageSyncPage, PublicMessage } from '@real-time-chat/contracts/messages';

test('recovers missing events while connected, keeps H fixed under live traffic and never duplicates rows', async ({ page, context }) => {
  test.setTimeout(60000);
  const suffix = randomUUID(), name = `Gap ${suffix}`, email = `gap-${suffix}@example.test`, password = 'a unique gap passphrase';
  const errors: string[] = [], dropped: string[] = [], pages: { query: URL; data: MessageSyncPage }[] = [];
  let upgraded = false, connections = 0, phase: 'initial' | 'bounded' | 'later' = 'initial';
  const release = Promise.withResolvers<void>();
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**/socket.io/**', socket => {
    connections++;
    const server = socket.connectToServer();
    socket.onMessage(frame => { if (frame === '5') upgraded = true; server.send(frame); });
    server.onMessage(frame => {
      const match = typeof frame === 'string' && /^42(\[.*)$/.exec(frame);
      if (match) {
        const [event, message] = JSON.parse(match[1]!) as [string, PublicMessage];
        // Lose the new invalidation too: this scenario must still repair through focus/timer.
        if (event === 'activity:changed') return;
        if (event === 'message:created' && message.body.startsWith('Missing ')) { dropped.push(message.id); return; }
      }
      socket.send(frame);
    });
  });
  await page.goto('/register');
  await page.getByLabel('Display name', { exact: true }).fill('Gap Reader');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?registered=1$/);
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
  await expect.poll(() => upgraded).toBe(true);
  const origin = process.env.E2E_BASE_URL!;
  const csrf = (await (await context.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken;
  const response = await context.request.post('/api/channels', { headers: { origin, 'x-csrf-token': csrf }, data: { name, slug: `gap-${suffix}` } });
  expect(response.status()).toBe(201); const { channel } = await response.json();
  const cookie = (await context.cookies()).find(value => value.name === 'chat_session')!;
  const sender = io(origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { origin, cookie: `${cookie.name}=${cookie.value}` } });
  const ids: string[] = [];
  const send = async (body: string): Promise<string> => {
    const ack = await sender.timeout(5000).emitWithAck('message:send', { channelId: channel.id, clientMessageId: randomUUID(), body });
    expect(ack.ok).toBe(true); ids.push(ack.data.id); return ack.data.id;
  };
  const rows = page.getByRole('log', { name: 'Conversation messages' }).locator('[data-message-id]');
  const expectIds = async (expected: string[]) => {
    await expect.poll(() => rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id')))).toEqual(expected);
  };
  try {
    await new Promise<void>((resolve, reject) => { sender.once('connect', resolve); sender.once('connect_error', reject); sender.connect(); });
    await page.route(`**/api/channels/${channel.id}/messages/sync?*`, async route => {
      if (phase === 'bounded') await release.promise;
      const response = await route.fetch(), data: MessageSyncPage = await response.json();
      pages.push({ query: new URL(route.request().url()), data });
      if (phase === 'bounded' && !route.request().url().includes('until=')) {
        await send('Live after H');
        await expectIds(ids.slice(105));
      }
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Refresh channels', exact: true }).click();
    const initialResponse = page.waitForResponse(response => response.url().includes('/messages/sync?') && response.status() === 200);
    await page.getByRole('button', { name: `Open chat ${name}`, exact: true }).click();
    await initialResponse;
    await expect(page.getByText('Recovering missed messages…', { exact: true })).toHaveCount(0);
    expect(pages).toHaveLength(1); const initialC = pages[0]!.data.nextCursor;
    // Keep the conversation outside the viewport so automatic reading cannot start another recovery.
    await page.getByRole('heading', { name: 'Create a channel', exact: true }).scrollIntoViewIfNeeded();
    phase = 'bounded'; pages.length = 0;
    for (let i = 1; i <= 105; i++) await send(`Missing ${i}`);
    await expect.poll(() => dropped.length).toBe(105); expect(dropped).toEqual(ids);
    await expectIds([]);
    const live = await send('Live beyond the gap'); await expectIds([live]);
    expect((await (await context.request.get(`/api/channels/${channel.id}/read-cursor`)).json()).lastReadSequence).toBe('0');
    // Release any periodic request already waiting, or start one explicitly through focus.
    release.resolve(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expectIds(ids);
    await expect(page.getByText('Recovering missed messages…', { exact: true })).toHaveCount(0);
    expect(ids).toHaveLength(107); expect(pages).toHaveLength(3);
    expect(pages.map(page => page.data.items.length)).toEqual([50, 50, 6]);
    expect(pages[0]!.query.searchParams.get('after')).toBe(initialC);
    const h = pages[0]!.data.until;
    expect(pages.slice(1).map(page => page.query.searchParams.get('until'))).toEqual([h, h]);
    expect(pages.map(page => page.data.until)).toEqual([h, h, h]);
    expect(pages[2]!.data.nextCursor).toBe(h); expect(pages[2]!.data.hasMore).toBe(false);
    expect(pages.flatMap(page => page.data.items.map(item => item.id))).toEqual(ids.slice(0, 106));
    phase = 'later';
    for (let attempt = 0; attempt < 2; attempt++) {
      const after = pages.at(-1)!.data.nextCursor;
      const recovered = page.waitForResponse(response => response.url().includes('/messages/sync?') && response.status() === 200);
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await recovered;
      await expect(page.getByText('Recovering missed messages…', { exact: true })).toHaveCount(0);
      expect(pages.at(-1)!.query.searchParams.get('after')).toBe(after);
      expect(pages.at(-1)!.data.items.map(item => item.id)).toEqual(attempt ? [] : [ids[106]]);
      await expectIds(ids);
    }
    expect(connections).toBe(1);
    await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toHaveCount(0);
    expect(new Set(ids).size).toBe(107); expect(dropped).toEqual(ids.slice(0, 105));
  } finally {
    release.resolve(); await page.unrouteAll({ behavior: 'wait' }); sender.disconnect();
  }
  expect(errors).toEqual([]);
});
