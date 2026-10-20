import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { test, expect } from './fixtures';

test('persists foreign-message counts and synchronizes reached messages without reading in background', async ({ page, context, browser, chatAccount }) => {
  test.setTimeout(90000);
  const origin = process.env.E2E_BASE_URL!, suffix = randomUUID();
  const { channel, sender: ownSender } = chatAccount;
  const csrf = async (request: typeof context.request) => ({ origin, 'x-csrf-token': (await (await request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken });
  const created = await context.request.post('/api/channels', { headers: await csrf(context.request), data: { name: `Unread other ${suffix}`, slug: `aab-${suffix}` } });
  expect(created.status()).toBe(201);
  const other = (await created.json()).channel;
  const writer = await browser.newContext({ baseURL: origin });
  const tab = await context.newPage();
  const errors: string[] = [];
  for (const view of [page, tab]) view.on('pageerror', error => errors.push(error.message));
  let sender: ReturnType<typeof io> | undefined;
  try {
    const preauth = { origin, 'x-csrf-token': (await (await writer.request.get('/api/auth/csrf', { headers: { origin } })).json()).csrfToken };
    const account = { email: `unread-writer-${suffix}@example.test`, password: 'an isolated unread passphrase', displayName: 'Unread Writer' };
    expect((await writer.request.post('/api/auth/register', { headers: preauth, data: account })).status()).toBe(201);
    expect((await writer.request.post('/api/auth/login', { headers: preauth, data: { email: account.email, password: account.password } })).status()).toBe(200);
    for (const id of [channel.id, other.id]) expect((await writer.request.put(`/api/channels/${id}/membership`, { headers: await csrf(writer.request) })).status()).toBe(200);
    const cookie = (await writer.cookies()).find(cookie => cookie.name === 'chat_session')!;
    sender = io(origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { origin, cookie: `${cookie.name}=${cookie.value}` } });
    await new Promise<void>((resolve, reject) => { sender!.once('connect', resolve); sender!.once('connect_error', reject); sender!.connect(); });
    const send = async (id: string, body: string, socket = sender!) => {
      const ack = await socket.timeout(5000).emitWithAck('message:send', { channelId: id, body, clientMessageId: randomUUID() });
      expect(ack.ok).toBe(true); return ack.data as { sequence: string; id: string };
    };
    const row = (view: typeof page, name = channel.name) => view.getByRole('list', { name: 'Available channels' }).getByRole('listitem').filter({ has: view.getByText(name, { exact: true }) });
    const count = async (value: number, name = channel.name) => {
      for (const view of [page, tab]) await expect(row(view, name).getByLabel(`${value} unread messages in ${name}`, { exact: true })).toBeVisible();
    };
    const cursor = async () => {
      const response = await context.request.get(`/api/channels/${channel.id}/read-cursor`);
      expect(response.status()).toBe(200); return (await response.json()).lastReadSequence as string;
    };
    await Promise.all([page.goto('/workspace'), tab.goto('/workspace')]);
    for (const view of [page, tab]) await expect(view.getByText('Live connection established.', { exact: true })).toBeVisible();
    await send(channel.id, 'My own message does not count', ownSender); await count(0);
    const first = await send(channel.id, 'Foreign unread'); await count(1);
    await send(other.id, 'Unread in the other channel'); await count(1, other.name);
    await page.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
    await page.locator(`[data-read-sequence="${first.sequence}"]`).scrollIntoViewIfNeeded();
    await expect.poll(cursor).toBe(first.sequence); await count(0);
    await page.reload(); await count(0); await count(1, other.name);
    await page.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
    await expect(page.getByText('Live conversation ready.', { exact: true })).toBeVisible();

    // Headless Chromium keeps pages visible; control the browser visibility boundary explicitly.
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    const hidden = await send(channel.id, 'Received while hidden');
    await expect(page.locator(`[data-message-id="${hidden.id}"]`)).toHaveCount(1);
    await expect(row(tab).getByLabel(`1 unread messages in ${channel.name}`, { exact: true })).toBeVisible();
    expect(await cursor()).toBe(first.sequence);
    let rejectRead = true;
    await page.route(`**/api/channels/${channel.id}/read-cursor`, route => route.request().method() === 'PUT' && rejectRead
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue());
    await page.evaluate(() => { delete (document as unknown as Record<string, unknown>)['visibilityState']; document.dispatchEvent(new Event('visibilitychange')); });
    await page.locator(`[data-read-sequence="${hidden.sequence}"]`).scrollIntoViewIfNeeded();
    await expect(page.getByText(/Could not save your reading progress/)).toBeVisible();
    expect(await cursor()).toBe(first.sequence);
    rejectRead = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(cursor).toBe(hidden.sequence); await count(0);

    await page.getByRole('button', { name: 'Close conversation', exact: true }).click();
    for (let index = 0; index < 10; index++) await send(channel.id, `Earlier ${index}: ${'context '.repeat(60)}`);
    await count(10);
    await page.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
    const markers = page.locator('[data-read-sequence]');
    await expect(markers).toHaveCount(13);
    await markers.last().scrollIntoViewIfNeeded(); await count(0);
    const before = await cursor();
    await page.getByRole('log').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await markers.first().scrollIntoViewIfNeeded();
    const below = await send(channel.id, 'Do not mark what is below the reader');
    await expect(page.locator(`[data-message-id="${below.id}"]`)).toHaveCount(1);
    await count(1); expect(await cursor()).toBe(before);
    await page.getByRole('button', { name: 'New messages — show latest', exact: true }).click();
    await page.locator(`[data-read-sequence="${below.sequence}"]`).scrollIntoViewIfNeeded();
    await expect.poll(cursor).toBe(below.sequence); await count(0); await count(1, other.name);
    expect(errors).toEqual([]);
  } finally { sender?.disconnect(); await tab.close(); await writer.close(); }
});
