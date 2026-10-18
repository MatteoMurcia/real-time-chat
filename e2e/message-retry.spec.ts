import { randomUUID } from 'node:crypto';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import type { PublicMessage, SendMessageRequest } from '@real-time-chat/contracts/messages';

test('reconciles late and lost confirmations with one automatic retry and the original key', async ({ page, context }) => {
  test.setTimeout(60000);
  const suffix = randomUUID(), name = `Retry ${suffix}`, slug = `retry-${suffix}`;
  const errors: string[] = [], requests: SendMessageRequest[] = [], events: PublicMessage[] = [];
  const held: { socket: WebSocketRoute; frame: string }[] = [];
  let upgraded = false;
  page.on('pageerror', error => errors.push(error.message));
  // Keep HTTP recovery unavailable so this scenario exercises acknowledgement recovery itself.
  await page.route('**/api/channels/*/messages/sync?*', route => route.abort('failed'));
  await page.routeWebSocket('**/socket.io/**', socket => {
    const server = socket.connectToServer();
    const acks = new Map<string, 'hold' | 'drop' | 'pass'>();
    socket.onMessage(frame => {
      if (frame === '5') upgraded = true;
      const match = typeof frame === 'string' && /^42(\d+)(\[.*)$/.exec(frame);
      if (match) {
        const [event, request] = JSON.parse(match[2]!) as [string, SendMessageRequest];
        if (event === 'message:send') {
          requests.push(request);
          const attempt = requests.filter(item => item.clientMessageId === request.clientMessageId).length;
          acks.set(match[1]!, request.body === 'Late confirmation' ? 'hold' : request.body === 'Lost confirmation' && attempt <= 2 ? 'drop' : 'pass');
          // Let the real API reject invalid content; production has no fault-injection switch.
          if (request.body === 'Rejected confirmation') {
            server.send(`42${match[1]}${JSON.stringify([event, { ...request, body: '' }])}`); return;
          }
        }
      }
      server.send(frame);
    });
    server.onMessage(frame => {
      const ack = typeof frame === 'string' && /^43(\d+)(\[.*)$/.exec(frame);
      if (ack) {
        const action = acks.get(ack[1]!);
        if (action === 'hold') { held.push({ socket, frame: frame as string }); return; }
        if (action === 'drop') return;
      }
      const event = typeof frame === 'string' && /^42(\[.*)$/.exec(frame);
      if (event) {
        const [name, message] = JSON.parse(event[1]!) as [string, PublicMessage];
        if (name === 'message:created') {
          events.push(message);
          if (['Late confirmation', 'Lost confirmation'].includes(message.body)) return;
        }
      }
      socket.send(frame);
    });
  });
  await page.goto('/register');
  await page.getByLabel('Display name', { exact: true }).fill('Retry Reader');
  await page.getByLabel('Email address', { exact: true }).fill(`retry-${suffix}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a unique retry passphrase');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?registered=1$/);
  await page.getByLabel('Email address', { exact: true }).fill(`retry-${suffix}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a unique retry passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
  await expect.poll(() => upgraded).toBe(true);
  await page.getByLabel('Channel name', { exact: true }).fill(name);
  await page.getByLabel('Channel slug', { exact: true }).fill(slug);
  await page.getByRole('button', { name: 'Create channel', exact: true }).click();
  await page.getByRole('button', { name: `Open chat ${name}`, exact: true }).click();
  await expect(page.getByText('Live conversation ready.', { exact: true })).toBeVisible();
  const log = page.getByRole('log', { name: 'Conversation messages' });
  const send = async (body: string) => {
    await page.getByLabel('Message', { exact: true }).fill(body);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
  };
  await send('Late confirmation');
  await expect.poll(() => held.length, { timeout: 10000 }).toBe(2);
  await expect(log).toContainText('Retrying confirmation…');
  expect(requests[1]).toEqual(requests[0]);
  held[0]!.socket.send(held[0]!.frame);
  await expect(log.locator('article')).toHaveCount(1); await expect(log).toContainText('Confirmed');
  held[1]!.socket.send(held[1]!.frame);
  await send('Lost confirmation');
  await expect(log).toContainText('Unconfirmed — it may already be saved.', { timeout: 15000 });
  const lost = requests.filter(item => item.body === 'Lost confirmation');
  expect(lost).toHaveLength(2); expect(lost[1]).toEqual(lost[0]);
  await page.getByRole('button', { name: 'Retry confirmation for message 1', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  await expect(log.locator('.outgoing')).toHaveCount(0);
  await expect(log.locator('article')).toHaveCount(2);
  expect(requests.filter(item => item.body === 'Lost confirmation')).toEqual([lost[0], lost[0], lost[0]]);
  await send('Rejected confirmation');
  await expect(log).toContainText('Rejected — copy the text to send a corrected message.');
  await expect(page.getByRole('button', { name: /^Retry confirmation for message/ })).toHaveCount(0);
  // Let another real 5s deadline pass to prove there is no third automatic send or retry of rejection.
  await page.waitForTimeout(5500);
  expect(requests).toHaveLength(6);
  expect(events.map(message => message.body)).toEqual(['Late confirmation', 'Lost confirmation']);
  const response = await context.request.get(`/api/channels/${requests[0]!.channelId}/messages`);
  expect(response.ok()).toBe(true);
  const saved = await response.json();
  expect(saved.items.map((message: PublicMessage) => message.id)).toEqual(events.map(message => message.id));
  await expect(log.locator('[data-message-id]')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/message-retry.png', fullPage: true });
  expect(errors).toEqual([]);
});
