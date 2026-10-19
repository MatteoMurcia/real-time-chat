import { randomUUID } from 'node:crypto';
import type { WebSocketRoute } from '@playwright/test';
import type { PublicMessage, SendMessageAck } from '@real-time-chat/contracts/messages';
import { expect, test } from './fixtures.js';

test('renders ten concurrent retries as one canonical row and rejects conflicting content', async ({ page, context, chatAccount }) => {
  const { channel, sender } = chatAccount;
  await page.goto('/workspace');
  await page.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
  await expect(page.getByText('Live conversation ready.', { exact: true })).toBeVisible();
  await expect(page.getByText('No messages yet. Say hello.', { exact: true })).toBeVisible();
  const input = { channelId: channel.id, clientMessageId: randomUUID(), body: 'Ten requests, one message' };
  const results: SendMessageAck[] = await Promise.all(Array.from({ length: 10 }, () => sender.timeout(5000).emitWithAck('message:send', input)));
  expect(results.every(result => result.ok)).toBe(true);
  const first = results[0]!;
  if (!first.ok) throw new Error('Concurrent send was rejected');
  expect(results).toEqual(Array(10).fill(first));
  const rows = page.getByRole('log', { name: 'Conversation messages' }).locator('article');
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute('data-message-id', first.data.id);
  await expect(rows.locator('.body')).toHaveText(input.body);
  expect(await sender.timeout(5000).emitWithAck('message:send', { ...input, body: 'Conflicting content' }))
    .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  const saved = await context.request.get(`/api/channels/${channel.id}/messages`);
  expect(saved.ok()).toBe(true);
  expect((await saved.json()).items).toEqual([first.data]);
  await expect(rows).toHaveCount(1);
});

test('reconciles both event-before-ack and ack-before-event without pending or duplicate rows', async ({ page, context, chatAccount }) => {
  const { channel } = chatAccount;
  const held = new Map<string, { socket: WebSocketRoute; ack?: string; event?: string; message?: PublicMessage }>();
  let upgraded = false;
  await page.addInitScript(() => {
    // Observe page delivery, not the native server socket that Playwright creates behind its route.
    const dispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (event: Event) {
      if (this instanceof WebSocket && event instanceof MessageEvent && typeof event.data === 'string' && /^4[23]/.test(event.data)) {
        document.documentElement.dataset.receivedConfirmation = event.data;
      }
      return dispatch.call(this, event);
    };
  });
  // Exclude HTTP recovery so only the two real Socket.IO confirmations can settle these sends.
  await page.route('**/api/channels/*/messages/sync?*', route => route.abort('failed'));
  await page.routeWebSocket('**/socket.io/**', socket => {
    const server = socket.connectToServer(), requests = new Map<string, string>();
    socket.onMessage(frame => {
      if (frame === '5') upgraded = true;
      const match = typeof frame === 'string' && /^42(\d+)(\[.*)$/.exec(frame);
      if (match) {
        const [name, input] = JSON.parse(match[2]!);
        if (name === 'message:send') requests.set(match[1]!, input.body);
      }
      server.send(frame);
    });
    server.onMessage(frame => {
      const ack = typeof frame === 'string' && /^43(\d+)(\[.*)$/.exec(frame);
      if (ack && requests.has(ack[1]!)) {
        const body = requests.get(ack[1]!)!, entry = held.get(body) ?? { socket };
        entry.ack = frame as string; held.set(body, entry); return;
      }
      const event = typeof frame === 'string' && /^42(\[.*)$/.exec(frame);
      if (event) {
        const [name, message] = JSON.parse(event[1]!) as [string, PublicMessage];
        if (name === 'message:created') {
          const entry = held.get(message.body) ?? { socket };
          entry.event = frame as string; entry.message = message; held.set(message.body, entry); return;
        }
      }
      socket.send(frame);
    });
  });
  await page.goto('/workspace');
  await expect.poll(() => upgraded).toBe(true);
  await page.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
  await expect(page.getByText('Live conversation ready.', { exact: true })).toBeVisible();
  await expect(page.getByText('No messages yet. Say hello.', { exact: true })).toBeVisible();
  const log = page.getByRole('log', { name: 'Conversation messages' });
  const messages: PublicMessage[] = [];
  for (const first of ['event', 'ack'] as const) {
    const body = `${first} first`;
    await page.getByLabel('Message', { exact: true }).fill(body);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => !!held.get(body)?.ack && !!held.get(body)?.event).toBe(true);
    await expect(log.locator('.outgoing')).toHaveCount(1);
    const entry = held.get(body)!;
    messages.push(entry.message!);
    entry.socket.send(entry[first]!);
    await expect(log.locator('.outgoing')).toHaveCount(0);
    await expect(log.locator('[data-message-id]')).toHaveCount(messages.length);
    await expect(log.locator('[data-message-id]').last()).toHaveAttribute('data-message-id', entry.message!.id);
    const second = entry[first === 'event' ? 'ack' : 'event']!;
    entry.socket.send(second);
    await expect(page.locator('html')).toHaveAttribute('data-received-confirmation', second);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(log.locator('.outgoing')).toHaveCount(0);
    await expect(log.locator('[data-message-id]')).toHaveCount(messages.length);
  }
  const saved = await context.request.get(`/api/channels/${channel.id}/messages`);
  expect(saved.ok()).toBe(true);
  expect((await saved.json()).items).toEqual(messages);
});
