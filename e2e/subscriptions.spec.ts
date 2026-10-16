import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

test('authorizes subscriptions through the proxy and revokes every socket on HTTP leave', async ({ playwright }) => {
  const origin = process.env.E2E_BASE_URL!;
  const contexts: APIRequestContext[] = [], sockets: Socket[] = [];
  const suffix = randomUUID();
  const createUser = async (index: number) => {
    const api = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { origin } });
    contexts.push(api);
    const email = `subscriptions-${index}-${suffix}@example.test`, password = 'a unique subscription passphrase';
    const preauth = async () => ({ 'x-csrf-token': (await (await api.get('/api/auth/csrf')).json()).csrfToken });
    expect((await api.post('/api/auth/register', { headers: await preauth(), data: { email, password, displayName: 'Subscription user' } })).status()).toBe(201);
    const login = await api.post('/api/auth/login', { headers: await preauth(), data: { email, password } });
    expect(login.status()).toBe(200);
    const { user } = await login.json();
    const headers = { 'x-csrf-token': (await (await api.get('/api/auth/session/csrf')).json()).csrfToken };
    const cookie = (await api.storageState()).cookies.map(item => `${item.name}=${item.value}`).join('; ');
    return { api, headers, cookie, user };
  };
  const connect = async (cookie: string, claimedUserId: string) => {
    const socket = io(origin, { autoConnect: false, reconnection: false, timeout: 3000, transports: ['websocket'],
      auth: { userId: claimedUserId, authorId: claimedUserId }, query: { userId: claimedUserId }, extraHeaders: { origin, cookie } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    return socket;
  };
  try {
    const [owner, other] = await Promise.all([createUser(0), createUser(1)]);
    const created = await owner.api.post('/api/channels', { headers: owner.headers, data: { name: `Proxy ${suffix}`, slug: `proxy-${suffix}` } });
    expect(created.status()).toBe(201);
    const { channel } = await created.json();
    const [first, second, third] = await Promise.all([connect(owner.cookie, other.user.id), connect(owner.cookie, other.user.id), connect(other.cookie, owner.user.id)]);
    const subscribe = (socket: Socket) => socket.timeout(3000).emitWithAck('channel:subscribe', { channelId: channel.id });
    expect(await subscribe(third)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const input = { channelId: channel.id, clientMessageId: randomUUID(), body: 'Persistent message through the proxy 🌍' };
    expect(await third.timeout(3000).emitWithAck('message:send', input)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect((await other.api.get(`/api/channels/${channel.id}/messages`)).status()).toBe(403);
    expect((await other.api.put(`/api/channels/${channel.id}/membership`, { headers: owner.headers })).status()).toBe(403);
    expect((await other.api.put(`/api/channels/${channel.id}/membership`, { headers: { ...other.headers, origin: `${origin}.evil.test` } })).status()).toBe(403);
    expect((await other.api.put(`/api/channels/${channel.id}/membership?userId=${owner.user.id}`, { headers: other.headers })).status()).toBe(400);
    expect(await subscribe(third)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect((await other.api.put(`/api/channels/${channel.id}/membership`, { headers: other.headers })).status()).toBe(200);
    for (const socket of sockets) expect(await subscribe(socket)).toEqual({ ok: true, data: { channelId: channel.id, subscribed: true } });
    const messages: unknown[] = [];
    third.on('message:created', message => messages.push(message));
    expect(await first.timeout(3000).emitWithAck('message:send', { ...input, authorId: other.user.id })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    const sent = await first.timeout(3000).emitWithAck('message:send', input);
    expect(sent).toMatchObject({ ok: true, data: { ...input, sequence: '1', author: { id: owner.user.id } } });
    expect(await second.timeout(3000).emitWithAck('message:send', input)).toEqual(sent);
    await subscribe(third);
    expect(messages).toEqual([sent.data]);
    const revoked: unknown[] = [];
    first.on('channel:access-revoked', payload => revoked.push(payload));
    second.on('channel:access-revoked', payload => revoked.push(payload));
    expect((await owner.api.delete(`/api/channels/${channel.id}/membership`, { headers: owner.headers })).status()).toBe(200);
    await expect.poll(() => revoked).toEqual([{ channelId: channel.id }, { channelId: channel.id }]);
    for (const socket of [first, second]) expect(await subscribe(socket)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await first.timeout(3000).emitWithAck('message:send', input)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const history = await (await other.api.get(`/api/channels/${channel.id}/messages`)).json();
    expect(history.items).toEqual([sent.data]);
    expect((await owner.api.get(`/api/channels/${channel.id}/messages?before=${history.snapshotCursor}`)).status()).toBe(403);
    expect((await owner.api.get(`/api/channels/${channel.id}/messages/sync?after=${history.snapshotCursor}`)).status()).toBe(403);
    expect((await subscribe(third)).ok).toBe(true);
    expect(await third.timeout(3000).emitWithAck('channel:unsubscribe', { channelId: channel.id })).toEqual({ ok: true, data: { channelId: channel.id, subscribed: false } });
  } finally {
    for (const socket of sockets) socket.disconnect();
    for (const api of contexts) await api.dispose();
  }
});
