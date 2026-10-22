import { randomUUID } from 'node:crypto';
import type { WebSocketRoute } from '@playwright/test';
import { test, expect } from './fixtures';

test('keeps a user online across tabs, distinguishes reconnecting and omitted members from offline', async ({ page, context, browser, chatAccount }) => {
  test.setTimeout(60000);
  const origin = process.env.E2E_BASE_URL!, { channel } = chatAccount;
  const writer = await browser.newContext({ baseURL: origin });
  const errors: string[] = [];
  let readerSocket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/socket.io/**', socket => { readerSocket = socket; socket.connectToServer(); });
  page.on('pageerror', error => errors.push(error.message));
  try {
    const headers = { origin, 'x-csrf-token': (await (await writer.request.get('/api/auth/csrf', { headers: { origin } })).json()).csrfToken };
    const account = { email: `presence-${randomUUID()}@example.test`, password: 'a separate presence passphrase', displayName: 'PresenceWriter'.repeat(5) };
    expect((await writer.request.post('/api/auth/register', { headers, data: account })).status()).toBe(201);
    expect((await writer.request.post('/api/auth/login', { headers, data: { email: account.email, password: account.password } })).status()).toBe(200);
    const auth = { origin, 'x-csrf-token': (await (await writer.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken };
    expect((await writer.request.put(`/api/channels/${channel.id}/membership`, { headers: auth })).status()).toBe(200);
    const tabs = [await writer.newPage(), await writer.newPage()];
    for (const view of [page, ...tabs]) {
      await view.goto('/workspace');
      await view.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
      await expect(view.getByText('Live conversation ready.', { exact: true })).toBeVisible();
    }
    await tabs[0]!.getByRole('textbox', { name: 'Message', exact: true }).fill('Presence across two tabs');
    await tabs[0]!.getByRole('button', { name: 'Send message', exact: true }).click();
    const badge = page.getByRole('log').locator('.presence');
    await expect(badge).toHaveText('Online');
    await tabs[0]!.close();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(badge).toHaveText('Online');
    await page.screenshot({ path: 'test-results/presence-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/presence-mobile.png', fullPage: true });
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Keep my draft across reconnection');
    await expect.poll(() => !!readerSocket).toBe(true);
    await context.setOffline(true);
    await readerSocket!.close({ code: 1001, reason: 'Test network interruption' });
    await expect(page.getByText('Connection interrupted. Reconnecting…', { exact: true })).toBeVisible();
    await expect(badge).toHaveText('Presence unknown', { timeout: 10000 });
    await context.setOffline(false);
    await expect(page.getByText('Live conversation ready.', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(badge).toHaveText('Online', { timeout: 10000 });
    await expect(composer).toHaveValue('Keep my draft across reconnection');
    await tabs[1]!.close();
    await expect(badge).toHaveText('Offline', { timeout: 10000 });
    expect((await writer.request.delete(`/api/channels/${channel.id}/membership`, { headers: auth })).status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(badge).toHaveText('Presence unknown', { timeout: 10000 });
    expect(errors).toEqual([]);
  } finally { await context.setOffline(false); await writer.close(); }
});

test('retains confirmed presence during a delayed refresh and discards replies after changing channels', async ({ page, context, chatAccount }) => {
  const { channel, sender } = chatAccount;
  const origin = process.env.E2E_BASE_URL!;
  const csrf = (await (await context.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken;
  const suffix = randomUUID();
  const created = await context.request.post('/api/channels', { headers: { origin, 'x-csrf-token': csrf },
    data: { name: `Presence ${suffix}`, slug: `aab-${suffix}` } });
  expect(created.status()).toBe(201);
  const other = (await created.json()).channel;
  let upgraded = false, hold = false;
  const held: { socket: WebSocketRoute; frame: string }[] = [];
  await page.routeWebSocket('**/socket.io/**', socket => {
    const server = socket.connectToServer(), requests = new Set<string>();
    socket.onMessage(frame => {
      if (frame === '5') upgraded = true;
      const match = typeof frame === 'string' && /^42(\d+)(\[.*)$/.exec(frame);
      if (match && JSON.parse(match[2]!)[0] === 'presence:get') requests.add(match[1]!);
      server.send(frame);
    });
    server.onMessage(frame => {
      const ack = typeof frame === 'string' && /^43(\d+)(\[.*)$/.exec(frame);
      if (hold && ack && requests.has(ack[1]!)) { held.push({ socket, frame: frame as string }); return; }
      socket.send(frame);
    });
  });
  await page.goto('/workspace');
  await expect.poll(() => upgraded).toBe(true);
  await page.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
  expect((await sender.timeout(5000).emitWithAck('message:send', { channelId: channel.id, clientMessageId: randomUUID(), body: 'A stable presence label' })).ok).toBe(true);
  const badge = page.getByRole('log').locator('.presence');
  await expect(badge).toHaveText('Online');
  await page.evaluate(() => {
    document.documentElement.dataset.presenceChanges = '';
    new MutationObserver(() => {
      document.documentElement.dataset.presenceChanges += document.querySelector('.presence')?.textContent + '|';
    }).observe(document.querySelector('.presence')!, { childList: true, characterData: true, subtree: true });
  });
  hold = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await expect(badge).toHaveText('Online');
  expect(await page.evaluate(() => document.documentElement.dataset.presenceChanges)).not.toMatch(/unknown|Offline/);
  await page.getByRole('button', { name: `Open chat ${other.name}`, exact: true }).click();
  hold = false;
  for (const reply of held) reply.socket.send(reply.frame);
  await expect(page.locator('.presence')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: `#${other.slug}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
  await expect(badge).toHaveText('Online');
});
