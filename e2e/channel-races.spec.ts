import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { io } from 'socket.io-client';

test('merges events around the initial snapshot and ignores retained A/B responses after returning to A', async ({ page, context }) => {
  test.setTimeout(60000);
  const suffix = randomUUID(), email = `races-${suffix}@example.test`, password = 'a unique channel race passphrase';
  const errors: string[] = [], syncRequests: URL[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/messages/sync')) syncRequests.push(new URL(request.url())); });
  await page.goto('/register');
  await page.getByLabel('Display name', { exact: true }).fill('Race Reader');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?registered=1$/);
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
  const origin = process.env.E2E_BASE_URL!;
  const csrf = (await (await context.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken;
  const create = async (label: string) => {
    const response = await context.request.post('/api/channels', { headers: { origin, 'x-csrf-token': csrf },
      data: { name: `${label} ${suffix}`, slug: `${label.toLowerCase()}-${suffix}` } });
    expect(response.status()).toBe(201); return (await response.json()).channel as { id: string; name: string };
  };
  const a = await create('A'), b = await create('B');
  const cookie = (await context.cookies()).find(value => value.name === 'chat_session')!;
  const socket = io(origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { origin, cookie: `${cookie.name}=${cookie.value}` } });
  const send = async (channelId: string, body: string): Promise<string> => {
    const ack = await socket.timeout(5000).emitWithAck('message:send', { channelId, clientMessageId: randomUUID(), body });
    expect(ack.ok).toBe(true); return ack.data.id;
  };
  const rows = page.getByRole('log', { name: 'Conversation messages' }).locator('[data-message-id]');
  const expectIds = async (ids: string[]) => {
    await expect.poll(() => rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id')))).toEqual(ids);
  };
  const gates: (() => void)[] = [];
  const held = new Map<string, { capture: (cursor: string) => void; released: Promise<void>; finish: () => void }>();
  const snapshots = new Map<string, string>();
  const holdSnapshot = (channelId: string) => {
    const captured = Promise.withResolvers<string>(), released = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
    gates.push(() => released.resolve());
    held.set(channelId, { capture: captured.resolve, released: released.promise, finish: finished.resolve });
    return { captured: captured.promise, release: async () => { released.resolve(); await finished.promise; } };
  };
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    const ids = [await send(a.id, 'Before opening A')];
    await send(b.id, 'Only in B');
    await page.getByRole('button', { name: 'Refresh channels', exact: true }).click();
    let initial = true;
    // Keep one interceptor installed while cancelled requests are still held.
    await page.route(/\/api\/channels\/[^/]+\/messages$/, async route => {
      const channelId = new URL(route.request().url()).pathname.split('/')[3]!;
      const gate = held.get(channelId); held.delete(channelId);
      const first = initial; initial = false;
      if (first) {
        ids.push(await send(a.id, 'Event before snapshot capture'));
        await expectIds([ids[1]!]);
      }
      const response = await route.fetch(), cursor = (await response.json()).snapshotCursor;
      snapshots.set(channelId, cursor);
      if (first) {
        ids.push(await send(a.id, 'Event while snapshot response is held'));
        await expectIds(ids.slice(1));
      }
      if (gate) { gate.capture(cursor); await gate.released; }
      try { await route.fulfill({ response }); } finally { gate?.finish(); }
    });
    const firstSync = page.waitForResponse(response => response.url().includes(`/channels/${a.id}/messages/sync?`) && response.status() === 200);
    await page.getByRole('button', { name: `Open chat ${a.name}`, exact: true }).click();
    await firstSync; await expectIds(ids);
    expect(syncRequests[0]!.searchParams.get('after')).toBe(snapshots.get(a.id));
    ids.push(await send(a.id, 'Event after snapshot merge')); await expectIds(ids);
    await page.getByRole('button', { name: 'Close conversation', exact: true }).click();
    await expect(page.getByRole('log', { name: 'Conversation messages' })).toHaveCount(0);

    const oldA = holdSnapshot(a.id);
    await page.getByRole('button', { name: `Open chat ${a.name}`, exact: true }).click();
    const obsoleteH = await oldA.captured;
    const oldB = holdSnapshot(b.id);
    await page.getByRole('button', { name: `Open chat ${b.name}`, exact: true }).click();
    await oldB.captured;
    ids.push(await send(a.id, 'Committed between the two A snapshots'));
    const freshSync = page.waitForResponse(response => response.url().includes(`/channels/${a.id}/messages/sync?`) && response.status() === 200);
    await page.getByRole('button', { name: `Open chat ${a.name}`, exact: true }).click();
    await freshSync; await expectIds(ids);
    const freshH = snapshots.get(a.id);
    expect(freshH).toBeTruthy(); expect(freshH).not.toBe(obsoleteH);
    await oldB.release(); await oldA.release();
    await expect(page.getByText('Recovering missed messages…', { exact: true })).toHaveCount(0);
    const afterStale = page.waitForRequest(request => new URL(request.url()).pathname === `/api/channels/${a.id}/messages/sync`);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(new URL((await afterStale).url()).searchParams.get('after')).toBe(freshH);
    await expectIds(ids);
    ids.push(await send(a.id, 'Still subscribed after A B A')); await expectIds(ids);
    await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry history', exact: true })).toHaveCount(0);
  } finally {
    for (const release of gates) release();
    await page.unrouteAll({ behavior: 'wait' }); socket.disconnect();
  }
  expect(errors).toEqual([]);
});
