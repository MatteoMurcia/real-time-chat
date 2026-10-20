import { randomUUID } from 'node:crypto';
import { expect, test, type Request } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

test('shares read progress across independent sessions and repairs a lost invalidation without focus', async ({ page, context, browser }) => {
  test.setTimeout(90000);
  const origin = process.env.E2E_BASE_URL!, suffix = randomUUID();
  const alice = { email: `read-alice-${suffix}@example.test`, password: 'an isolated reader passphrase', displayName: 'Read Alice' };
  const bob = { email: `read-bob-${suffix}@example.test`, password: 'an isolated writer passphrase', displayName: 'Read Bob' };
  const second = await browser.newContext({ baseURL: origin }), writer = await browser.newContext({ baseURL: origin });
  const tab = await second.newPage(), bobPage = await writer.newPage();
  const sockets: Socket[] = [], errors: string[] = [];
  let dropActivity = false, dropped = 0, connections = 0, upgraded = false, directoryReads = 0;
  const pendingReads = new Set<Request>();
  await tab.addInitScript(() => {
    const events = { focus: 0, visibility: 0 };
    Object.assign(window, { __readActivityEvents: events });
    window.addEventListener('focus', () => events.focus++);
    document.addEventListener('visibilitychange', () => events.visibility++);
  });
  for (const view of [page, tab, bobPage]) view.on('pageerror', error => errors.push(error.message));
  tab.on('request', request => {
    if (new URL(request.url()).pathname === '/api/channels' && request.method() === 'GET') { directoryReads++; pendingReads.add(request); }
  });
  tab.on('requestfinished', request => pendingReads.delete(request));
  tab.on('requestfailed', request => pendingReads.delete(request));
  await tab.routeWebSocket('**/socket.io/**', socket => {
    connections++;
    const server = socket.connectToServer();
    socket.onMessage(frame => { if (frame === '5') upgraded = true; server.send(frame); });
    server.onMessage(frame => {
      const packet = typeof frame === 'string' && /^42(\[.*)$/.exec(frame);
      if (packet && JSON.parse(packet[1]!)[0] === 'activity:changed' && dropActivity) { dropped++; return; }
      socket.send(frame);
    });
  });
  const csrf = async (request: typeof context.request) => ({ origin,
    'x-csrf-token': (await (await request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken });
  const login = async (request: typeof context.request, account: typeof alice, register: boolean) => {
    const headers = { origin, 'x-csrf-token': (await (await request.get('/api/auth/csrf', { headers: { origin } })).json()).csrfToken };
    if (register) expect((await request.post('/api/auth/register', { headers, data: account })).status()).toBe(201);
    expect((await request.post('/api/auth/login', { headers, data: { email: account.email, password: account.password } })).status()).toBe(200);
  };
  try {
    await login(context.request, alice, true); await login(second.request, alice, false); await login(writer.request, bob, true);
    const firstCookie = (await context.cookies()).find(cookie => cookie.name === 'chat_session')!;
    const secondCookie = (await second.cookies()).find(cookie => cookie.name === 'chat_session')!;
    expect(firstCookie.value !== secondCookie.value).toBe(true);
    const created = await context.request.post('/api/channels', { headers: await csrf(context.request), data: { name: `Read consistency ${suffix}`, slug: `aaa-read-${suffix}` } });
    expect(created.status()).toBe(201);
    const { channel } = await created.json();
    expect((await writer.request.put(`/api/channels/${channel.id}/membership`, { headers: await csrf(writer.request) })).status()).toBe(200);
    const senders = await Promise.all([context, writer].map(async actor => {
      const cookie = (await actor.cookies()).find(cookie => cookie.name === 'chat_session')!;
      const socket = io(origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { origin, cookie: `${cookie.name}=${cookie.value}` } });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
      return socket;
    }));
    const send = async (socket: Socket, body: string) => {
      const ack = await socket.timeout(5000).emitWithAck('message:send', { channelId: channel.id, clientMessageId: randomUUID(), body });
      expect(ack.ok).toBe(true); return ack.data as { sequence: string };
    };
    const count = (view: typeof page, value: number) => view.getByLabel(`${value} unread messages in ${channel.name}`, { exact: true });
    const cursor = async (request: typeof context.request) => {
      const response = await request.get(`/api/channels/${channel.id}/read-cursor`);
      expect(response.status()).toBe(200); return (await response.json()).lastReadSequence as string;
    };
    const reach = async (sequence: string) => {
      await page.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
      await page.locator(`[data-read-sequence="${sequence}"]`).scrollIntoViewIfNeeded();
      await expect.poll(() => cursor(context.request)).toBe(sequence);
      await expect(count(page, 0)).toBeVisible();
    };
    await Promise.all([page.goto('/workspace'), tab.goto('/workspace'), bobPage.goto('/workspace')]);
    for (const view of [page, tab, bobPage]) await expect(view.getByText('Live connection established.', { exact: true })).toBeVisible();
    await expect.poll(() => upgraded).toBe(true);
    const first = await send(senders[1]!, 'Foreign message one');
    const latest = await send(senders[1]!, 'Foreign message two');
    for (const view of [page, tab]) await expect(count(view, 2)).toBeVisible();
    await expect(count(bobPage, 0)).toBeVisible();
    await reach(latest.sequence); await expect(count(tab, 0)).toBeVisible();
    const stale = await second.request.put(`/api/channels/${channel.id}/read-cursor`, { headers: await csrf(second.request), data: { lastReadSequence: first.sequence } });
    expect(stale.status()).toBe(200);
    expect((await stale.json()).lastReadSequence).toBe(latest.sequence);
    expect(await cursor(second.request)).toBe(latest.sequence); expect(await cursor(writer.request)).toBe('0');
    await page.getByRole('button', { name: 'Close conversation', exact: true }).click();
    await send(senders[0]!, 'Alice own message');
    for (const view of [page, tab]) await expect(count(view, 0)).toBeVisible();
    await expect(count(bobPage, 1)).toBeVisible();
    const next = await send(senders[1]!, 'Foreign message after the saved boundary');
    for (const view of [page, tab]) await expect(count(view, 1)).toBeVisible();
    await expect.poll(() => pendingReads.size).toBe(0);
    dropActivity = true;
    const readsBefore = directoryReads;
    const triggersBefore = await tab.evaluate(() => (window as Window & { __readActivityEvents: { focus: number; visibility: number } }).__readActivityEvents);
    await reach(next.sequence);
    await expect.poll(() => dropped).toBeGreaterThan(0);
    expect(await cursor(second.request)).toBe(next.sequence);
    // No focus, visibility change, navigation or reconnect: the real 15s interval must repair the count.
    await expect(count(tab, 0)).toBeVisible({ timeout: 20000 });
    expect(directoryReads).toBeGreaterThan(readsBefore); expect(connections).toBe(1);
    expect(await tab.evaluate(() => (window as Window & { __readActivityEvents: { focus: number; visibility: number } }).__readActivityEvents)).toEqual(triggersBefore);
    await expect(tab.getByText('Live connection established.', { exact: true })).toBeVisible();
    expect(await cursor(writer.request)).toBe('0'); await expect(count(bobPage, 1)).toBeVisible();
    dropActivity = false;
    await tab.reload(); await expect(count(tab, 0)).toBeVisible();
    expect((await second.cookies()).find(cookie => cookie.name === 'chat_session')?.value === secondCookie.value).toBe(true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login\?reason=signed-out$/);
    expect((await second.request.get('/api/auth/me')).status()).toBe(200);
    await send(senders[1]!, 'Still delivered to the other session');
    await expect(count(tab, 1)).toBeVisible();
    expect(await cursor(second.request)).toBe(next.sequence); expect(errors).toEqual([]);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await second.close(); await writer.close();
  }
});
