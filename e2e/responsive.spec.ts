import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { io } from 'socket.io-client';

test('wraps long content, adapts to a reduced viewport and cleans up twenty channel changes', async ({ page, context }, testInfo) => {
  test.setTimeout(90000);
  const origin = process.env.E2E_BASE_URL!, suffix = randomUUID();
  const email = `${'reader'.repeat(9)}@${suffix}.example.test`, password = 'a unique responsive passphrase';
  const errors: string[] = [], subscriptions: { event: string; channelId: string }[] = [];
  const received: string[] = [], expectedLive: string[] = [];
  let upgraded = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    socket.on('framereceived', frame => {
      const payload = String(frame.payload);
      if (!/^42\d*\[/.test(payload)) return;
      const [event, message] = JSON.parse(payload.slice(payload.indexOf('[')));
      if (event === 'message:created') received.push(message.id);
    });
    socket.on('framesent', frame => {
      const payload = String(frame.payload);
      if (payload === '5') upgraded = true;
      if (!/^42\d*\[/.test(payload)) return;
      const [event, input] = JSON.parse(payload.slice(payload.indexOf('[')));
      if (event === 'channel:subscribe' || event === 'channel:unsubscribe') subscriptions.push({ event, channelId: input.channelId });
    });
  });
  const preauth = async () => ({ origin, 'x-csrf-token': (await (await context.request.get('/api/auth/csrf', { headers: { origin } })).json()).csrfToken });
  expect((await context.request.post('/api/auth/register', { headers: await preauth(), data: { email, password, displayName: 'MobileReader'.repeat(6) } })).status()).toBe(201);
  expect((await context.request.post('/api/auth/login', { headers: await preauth(), data: { email, password } })).status()).toBe(200);
  const headers = { origin, 'x-csrf-token': (await (await context.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken };
  const channels: { id: string; name: string; slug: string }[] = [];
  for (const label of ['A', 'B']) {
    const response = await context.request.post('/api/channels', { headers, data: { name: `${label.repeat(42)} ${suffix}`, slug: `${label.toLowerCase()}-${suffix}` } });
    expect(response.status()).toBe(201); channels.push((await response.json()).channel);
  }
  const cookie = (await context.cookies()).find(value => value.name === 'chat_session')!;
  const sender = io(origin, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { origin, cookie: `${cookie.name}=${cookie.value}` } });
  const cdp = await context.newCDPSession(page);
  const listenerCounts = async () => {
    const counts: number[] = [];
    for (const [expression, type] of [['window', 'focus'], ['document', 'visibilitychange']]) {
      const { result } = await cdp.send('Runtime.evaluate', { expression, objectGroup: 'responsive-listeners' });
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId! });
      counts.push(listeners.filter(listener => listener.type === type).length);
    }
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'responsive-listeners' });
    return counts;
  };
  try {
    await new Promise<void>((resolve, reject) => { sender.once('connect', resolve); sender.once('connect_error', reject); sender.connect(); });
    const saved: string[][] = [[], []];
    const send = async (index: number, body: string) => {
      const ack = await sender.timeout(5000).emitWithAck('message:send', { channelId: channels[index]!.id, clientMessageId: randomUUID(), body });
      expect(ack.ok).toBe(true); saved[index]!.push(ack.data.id); return ack.data.id as string;
    };
    const longBody = 'x'.repeat(2000);
    for (let index = 0; index < 12; index++) await send(0, index ? `Earlier message ${index}` : longBody);
    await send(1, 'Only in channel B');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/workspace');
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /interactive-widget=resizes-content/);
    await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
    await expect.poll(() => upgraded).toBe(true);
    const baseline = await listenerCounts();
    const rows = page.getByRole('log').locator('[data-message-id]');
    const expectRows = async (index: number) => {
      await expect.poll(() => rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id')))).toEqual(saved[index]);
    };
    const open = async (index: number) => {
      await page.getByRole('button', { name: `Open chat ${channels[index]!.name}`, exact: true }).click();
      await expect(page.getByText('Live conversation ready.', { exact: true })).toBeVisible();
      await expect(page.locator('#conversation-title')).toHaveText(`#${channels[index]!.slug}`);
      await expectRows(index);
    };
    await open(0);
    const activeListeners = await listenerCounts();
    expect(activeListeners).toEqual(baseline.map(count => count + 1));
    const composer = page.getByLabel('Message', { exact: true });
    await composer.fill('Draft survives viewport changes');
    for (const width of [320, 375, 768, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 812 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.getByRole('log').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(rows.first().locator('.body')).toHaveText(longBody);
      if (width === 375 || width === 1280) await page.screenshot({ path: testInfo.outputPath(`responsive-${width}.png`), fullPage: true });
    }
    await composer.focus();
    await page.setViewportSize({ width: 375, height: 400 });
    await expect(composer).toBeFocused(); await expect(composer).toHaveValue('Draft survives viewport changes');
    expect(await page.getByRole('log').evaluate(element => element.clientHeight)).toBeLessThanOrEqual(180);
    await composer.scrollIntoViewIfNeeded(); await expect(composer).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('responsive-reduced-height.png') });
    const submit = page.getByRole('button', { name: 'Send message', exact: true });
    await submit.scrollIntoViewIfNeeded(); await expect(submit).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 375, height: 812 });
    await composer.fill('');
    let closes = 0;
    for (let change = 1; change <= 20; change++) {
      const index = change % 2;
      if (change % 4 === 0) {
        await page.getByRole('button', { name: 'Close conversation', exact: true }).click(); closes++;
        await expect(page.locator('app-chat')).toHaveCount(0);
        expect(await listenerCounts()).toEqual(baseline);
      }
      await open(index);
      expect(await listenerCounts()).toEqual(activeListeners);
      await send(1 - index, `Inactive channel after change ${change}`);
      expectedLive.push(await send(index, `Live after change ${change}`)); await expectRows(index);
      await expect.poll(() => received).toEqual(expectedLive);
      await expect.poll(() => subscriptions.length).toBe(1 + change * 2);
    }
    expect(closes).toBe(5);
    const expected = [{ event: 'channel:subscribe', channelId: channels[0]!.id }];
    for (let change = 1; change <= 20; change++) {
      expected.push({ event: 'channel:unsubscribe', channelId: channels[(change - 1) % 2]!.id }, { event: 'channel:subscribe', channelId: channels[change % 2]!.id });
    }
    expect(subscriptions).toEqual(expected);
    await page.getByRole('button', { name: 'Close conversation', exact: true }).click();
    await expect(page.locator('app-chat')).toHaveCount(0);
    expect(await listenerCounts()).toEqual(baseline);
    await expect.poll(() => subscriptions.length).toBe(42);
    expect(subscriptions.at(-1)).toEqual({ event: 'channel:unsubscribe', channelId: channels[0]!.id });
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('link', { name: 'Workspace', exact: true }).click();
    await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
    expect(await listenerCounts()).toEqual(baseline);
    await open(0); expect(await listenerCounts()).toEqual(activeListeners);
    expect(errors).toEqual([]);
  } finally { sender.disconnect(); await cdp.detach(); }
});
