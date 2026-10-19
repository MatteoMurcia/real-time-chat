import { randomUUID } from 'node:crypto';
import { test as base, expect } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import type { PublicChannel } from '@real-time-chat/contracts/channels';

export const test = base.extend<{ chatAccount: { channel: PublicChannel; sender: Socket } }>({
  chatAccount: async ({ context }, use) => {
    const origin = process.env.E2E_BASE_URL!;
    const suffix = randomUUID(), email = `protocol-${suffix}@example.test`, password = 'a unique protocol passphrase';
    expect((await context.cookies()).some(cookie => cookie.name === 'chat_session')).toBe(false);
    const preauth = await context.request.get('/api/auth/csrf', { headers: { origin } });
    const headers = { origin, 'x-csrf-token': (await preauth.json()).csrfToken };
    expect((await context.request.post('/api/auth/register', { headers, data: { email, password, displayName: 'Protocol Reader' } })).status()).toBe(201);
    expect((await context.request.post('/api/auth/login', { headers, data: { email, password } })).status()).toBe(200);
    const csrf = await context.request.get('/api/auth/session/csrf', { headers: { origin } });
    const created = await context.request.post('/api/channels', {
      headers: { origin, 'x-csrf-token': (await csrf.json()).csrfToken },
      data: { name: `Protocol ${suffix}`, slug: `aaa-${suffix}` },
    });
    expect(created.status()).toBe(201);
    const { channel } = await created.json();
    const cookie = (await context.cookies()).find(cookie => cookie.name === 'chat_session')!;
    const sender = io(origin, { autoConnect: false, reconnection: false, transports: ['websocket'],
      extraHeaders: { origin, cookie: `${cookie.name}=${cookie.value}` } });
    try {
      await new Promise<void>((resolve, reject) => { sender.once('connect', resolve); sender.once('connect_error', reject); sender.connect(); });
      await use({ channel, sender });
    } finally { sender.disconnect(); }
  },
});
export { expect };
