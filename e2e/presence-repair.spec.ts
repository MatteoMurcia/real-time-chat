import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type { Request } from '@playwright/test';
import { test, expect } from './fixtures';

test('repairs lost presence hints and membership omission through the real timer without focus or reconnect', async ({ page, browser, chatAccount }) => {
  test.setTimeout(60000);
  const origin = process.env.E2E_BASE_URL!, { channel } = chatAccount;
  const writer = await browser.newContext({ baseURL: origin });
  let sender: Socket | undefined;
  let drop = false, dropped = 0, connections = 0, upgraded = false, queries = 0, lastQuery = 0, readWrites = 0;
  const pending = new Set<Request>(), errors: string[] = [];
  const pendingPresence = new Set<string>();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'PUT' && request.url().endsWith('/read-cursor')) { pending.add(request); readWrites++; }
  });
  page.on('requestfinished', request => pending.delete(request));
  page.on('requestfailed', request => pending.delete(request));
  await page.addInitScript(() => {
    const events = { focus: 0, visibility: 0 };
    Object.assign(window, { __presenceActivityEvents: events });
    window.addEventListener('focus', () => events.focus++);
    document.addEventListener('visibilitychange', () => events.visibility++);
  });
  const triggers = () => page.evaluate(() => (window as Window & { __presenceActivityEvents: { focus: number; visibility: number } }).__presenceActivityEvents);
  await page.routeWebSocket('**/socket.io/**', socket => {
    connections++;
    const server = socket.connectToServer();
    socket.onMessage(frame => {
      if (frame === '5') upgraded = true;
      const packet = typeof frame === 'string' && /^42(\d+)(\[.*)$/.exec(frame);
      if (packet && JSON.parse(packet[2]!)[0] === 'presence:get') {
        pendingPresence.add(packet[1]!); queries++; lastQuery = Date.now();
      }
      server.send(frame);
    });
    server.onMessage(frame => {
      const ack = typeof frame === 'string' && /^43(\d+)\[/.exec(frame);
      if (ack) pendingPresence.delete(ack[1]!);
      const packet = typeof frame === 'string' && /^42(\[.*)$/.exec(frame);
      const name = packet && JSON.parse(packet[1]!)[0];
      if (drop && (name === 'presence:changed' || name === 'activity:changed')) {
        if (name === 'presence:changed') dropped++;
        return;
      }
      socket.send(frame);
    });
  });
  try {
    const headers = { origin, 'x-csrf-token': (await (await writer.request.get('/api/auth/csrf', { headers: { origin } })).json()).csrfToken };
    const account = { email: `repair-${randomUUID()}@example.test`, password: 'an isolated presence repair passphrase', displayName: 'Presence Repair Writer' };
    expect((await writer.request.post('/api/auth/register', { headers, data: account })).status()).toBe(201);
    expect((await writer.request.post('/api/auth/login', { headers, data: { email: account.email, password: account.password } })).status()).toBe(200);
    const auth = { origin, 'x-csrf-token': (await (await writer.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken };
    expect((await writer.request.put(`/api/channels/${channel.id}/membership`, { headers: auth })).status()).toBe(200);
    const cookie = (await writer.cookies()).find(cookie => cookie.name === 'chat_session')!;
    sender = io(origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { origin, cookie: `${cookie.name}=${cookie.value}` } });
    const connected = new Promise<void>((resolve, reject) => { sender!.once('connect', resolve); sender!.once('connect_error', reject); });
    sender.connect(); await connected;
    await page.goto('/workspace');
    await expect.poll(() => upgraded).toBe(true);
    await page.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
    expect((await sender.timeout(5000).emitWithAck('message:send', { channelId: channel.id, clientMessageId: randomUUID(), body: 'Repair presence without replaying messages' })).ok).toBe(true);
    const badge = page.getByRole('log').locator('.presence');
    await expect(badge).toHaveText('Online');
    // Let read-triggered refreshes finish before excluding focus and invalidation triggers.
    await expect.poll(() => pending.size === 0 && pendingPresence.size === 0 && Date.now() - lastQuery > 2500,
      { timeout: 10000 }).toBe(true);
    const eventsBefore = await triggers(), queriesBefore = queries, writesBefore = readWrites;
    drop = true; sender.disconnect();
    await expect.poll(() => dropped).toBeGreaterThan(0);
    await expect(badge).toHaveText('Offline', { timeout: 20000 });
    expect(queries).toBeGreaterThan(queriesBefore);
    expect(readWrites).toBe(writesBefore);
    expect(await triggers()).toEqual(eventsBefore); expect(connections).toBe(1);
    const beforeLeave = queries;
    expect((await writer.request.delete(`/api/channels/${channel.id}/membership`, { headers: auth })).status()).toBe(200);
    await expect(badge).toHaveText('Presence unknown', { timeout: 20000 });
    expect(queries).toBeGreaterThan(beforeLeave);
    expect(readWrites).toBe(writesBefore);
    expect(await triggers()).toEqual(eventsBefore); expect(connections).toBe(1);
    await expect(page.getByRole('log').locator('article')).toHaveCount(1);
    await expect(page.locator('.typing')).toBeEmpty();
    await expect(page.getByText('Live conversation ready.', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { sender?.disconnect(); await writer.close(); }
});
