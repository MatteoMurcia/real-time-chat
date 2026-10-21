import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';

test('shows ephemeral typing without sharing drafts, expires an offline writer and clears on close or send', async ({ page, browser, chatAccount }) => {
  test.setTimeout(60000);
  const origin = process.env.E2E_BASE_URL!, { channel } = chatAccount;
  const writer = await browser.newContext({ baseURL: origin });
  const tab = await writer.newPage(), errors: string[] = [], typingFrames: unknown[] = [];
  for (const view of [page, tab]) view.on('pageerror', error => errors.push(error.message));
  tab.on('websocket', socket => socket.on('framesent', frame => {
    if (typeof frame.payload !== 'string' || !frame.payload.startsWith('42[')) return;
    const [event, payload] = JSON.parse(frame.payload.slice(2));
    if (event === 'typing:update') typingFrames.push(payload);
  }));
  try {
    const csrf = async () => ({ origin, 'x-csrf-token': (await (await writer.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken });
    const preauth = { origin, 'x-csrf-token': (await (await writer.request.get('/api/auth/csrf', { headers: { origin } })).json()).csrfToken };
    const account = { email: `typing-${randomUUID()}@example.test`, password: 'an ephemeral writing passphrase', displayName: 'Typing Writer' };
    expect((await writer.request.post('/api/auth/register', { headers: preauth, data: account })).status()).toBe(201);
    expect((await writer.request.post('/api/auth/login', { headers: preauth, data: { email: account.email, password: account.password } })).status()).toBe(200);
    expect((await writer.request.put(`/api/channels/${channel.id}/membership`, { headers: await csrf() })).status()).toBe(200);
    for (const view of [page, tab]) {
      await view.goto('/workspace');
      await view.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
      await expect(view.getByText('Live conversation ready.', { exact: true })).toBeVisible();
    }
    const composer = tab.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('A private draft that must never cross the network');
    await expect(page.locator('.typing')).toHaveText('Typing Writer is typing…');
    await expect(tab.locator('.typing')).toBeEmpty();
    await page.screenshot({ path: 'test-results/typing-desktop.png', fullPage: true });
    // The server may need its heartbeat timeout to detect this loss; the receiver must expire independently.
    await writer.setOffline(true);
    await expect(page.locator('.typing')).toBeEmpty({ timeout: 7000 });
    await writer.setOffline(false);
    await expect(tab.getByText('Live conversation ready.', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(composer).toHaveValue('A private draft that must never cross the network');
    await expect(page.locator('.typing')).toBeEmpty();
    await composer.fill('New input after reconnection');
    await expect(page.locator('.typing')).toHaveText('Typing Writer is typing…');
    await tab.getByRole('button', { name: 'Close conversation', exact: true }).click();
    await expect(page.locator('.typing')).toBeEmpty();
    await tab.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
    await expect(tab.getByText('Live conversation ready.', { exact: true })).toBeVisible();
    await composer.fill('A confirmed message');
    await expect(page.locator('.typing')).toHaveText('Typing Writer is typing…');
    await tab.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('log').getByText('A confirmed message', { exact: true })).toBeVisible();
    await expect(page.locator('.typing')).toBeEmpty();
    await expect.poll(() => typingFrames.length).toBeGreaterThan(0);
    for (const payload of typingFrames) expect(payload).toEqual({ channelId: channel.id, typing: expect.any(Boolean) });
    expect(errors).toEqual([]);
  } finally { await writer.close(); }
});
