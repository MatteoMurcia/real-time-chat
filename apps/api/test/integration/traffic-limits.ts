import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { isApiError } from '@real-time-chat/contracts';
import { createApp } from '../../src/app.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { SessionService } from '../../src/identity/session.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { ChatGateway } from '../../src/realtime/chat.gateway.js';
import { ConnectionsService } from '../../src/realtime/connections.service.js';
import { hashPassword } from '../../src/identity/password.js';

export async function verifyTrafficLimits(databaseUrl: string): Promise<void> {
  const { app } = await createApp({ NODE_ENV: 'test', PORT: '3000', DATABASE_URL: databaseUrl });
  await app.listen(0, '127.0.0.1');
  const db = app.get(DatabaseService), endpoint = await app.getUrl(), origin = 'http://127.0.0.1:8080';
  const sockets: Socket[] = [], users: string[] = [];
  const client = (cookie: string, transport = 'websocket') => {
    const socket = io(endpoint, { autoConnect: false, reconnection: false, timeout: 3000, transports: [transport], extraHeaders: { origin, cookie } });
    sockets.push(socket); return socket;
  };
  const connect = (socket: Socket) => new Promise<Error & { data?: unknown } | null>(resolve => {
    socket.once('connect', () => resolve(null)); socket.once('connect_error', resolve); socket.connect();
  });
  const limited = (body: unknown) => { assert.ok(isApiError(body)); assert.equal(body.code, 'RATE_LIMITED'); };
  let now = Date.now(); const clock = mock.method(Date, 'now', () => now);
  try {
    const bootstrap = await fetch(`${endpoint}/api/auth/csrf`, { headers: { origin } });
    let preauth = { origin, cookie: bootstrap.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': (await bootstrap.json() as { csrfToken: string }).csrfToken, 'content-type': 'application/json' };
    const post = (path: string, body: string, headers: Record<string, string> = preauth) => fetch(`${endpoint}/api/${path}`, { method: 'POST', headers, body });
    for (const path of ['auth/login', 'auth/register']) {
      const before = await db.user.count();
      const malformed = await post(path, '{'); assert.equal(malformed.status, 400); assert.ok(isApiError(await malformed.json()));
      const oversize = await post(path, JSON.stringify({ padding: 'x'.repeat(9000) })); assert.equal(oversize.status, 413);
      const count = path.endsWith('login') ? 10 : 5;
      for (let i = 0; i < count; i++) assert.equal((await post(path, '{}', { ...preauth, 'x-forwarded-for': `192.0.2.${i}` })).status, 400);
      const blocked = await post(path, '{}', { ...preauth, 'x-forwarded-for': '198.51.100.1' }); assert.equal(blocked.status, 429); limited(await blocked.json());
      assert.equal(await db.user.count(), before);
    }
    now += 60000;
    assert.equal((await post('auth/login', '{}')).status, 400);
    assert.equal((await post('auth/register', '{}')).status, 429);
    now += 3540000;
    const fresh = await fetch(`${endpoint}/api/auth/csrf`, { headers: { origin } });
    preauth = { ...preauth, cookie: fresh.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': (await fresh.json() as { csrfToken: string }).csrfToken };
    assert.equal((await post('auth/register', '{}')).status, 400);

    const password = 'traffic limits passphrase';
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, displayName: 'Limits', passwordHash: await hashPassword(password) } }); users.push(user.id);
    const identity = app.get(SessionService);
    const login = async () => (await identity.login({ email: user.email, password })).cookie.split(';')[0]!;
    const cookie = await login(), otherCookie = await login();
    const attempts = Array.from({ length: 6 }, () => client(cookie));
    const results = await Promise.all(attempts.map(connect));
    assert.equal(results.filter(error => error === null).length, 5);
    limited(results.find(error => error !== null)!.data);
    const first = attempts.find(socket => socket.connected)!, other = client(otherCookie);
    assert.equal(await connect(other), null);
    const disconnected = new Promise<void>(resolve => app.get(ChatGateway).server.of('/').sockets.get(first.id!)!.once('disconnect', () => resolve()));
    first.disconnect(); await disconnected;
    const replacement = client(cookie); assert.equal(await connect(replacement), null);

    // Reserve the fifth slot, then abort before namespace connection; no Socket disconnect fires.
    const active = attempts.filter(socket => socket.connected);
    const removed = active[0]!;
    const closed = new Promise<void>(resolve => app.get(ChatGateway).server.of('/').sockets.get(removed.id!)!.once('disconnect', () => resolve()));
    removed.disconnect(); await closed;
    let enter!: () => void, release!: () => void, engineClosed!: Promise<void>;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    let hold = true;
    app.get(ChatGateway).server.use(async (socket, next) => {
      if (hold && socket.request.headers.cookie === cookie) {
        hold = false; engineClosed = new Promise<void>(resolve => socket.conn.once('close', () => resolve())); enter(); await gate;
      }
      next();
    });
    const aborted = client(cookie); aborted.connect(); await entered;
    const full = await connect(client(cookie)); assert.ok(full); limited(full.data);
    aborted.disconnect(); await engineClosed; release();
    const restored = client(cookie); assert.equal(await connect(restored), null);

    const channels = app.get(ChannelsService);
    const channel = (await channels.create(user.id, { name: `Limits ${randomUUID()}`, slug: `limits-${randomUUID()}` })).channel;
    const message = { channelId: channel.id, clientMessageId: randomUUID(), body: '🌍'.repeat(2000) };
    for (let i = 0; i < 28; i++) {
      const ack = await (i % 2 ? other : replacement).timeout(3000).emitWithAck('message:send', { ...message, clientMessageId: i ? randomUUID() : message.clientMessageId }); assert.equal(ack.ok, true);
    }
    const malformed = await other.timeout(3000).emitWithAck('message:send', { ...message, body: '🌍'.repeat(2001) }); assert.equal(malformed.error.code, 'VALIDATION_ERROR');
    const retry = await replacement.timeout(3000).emitWithAck('message:send', message); assert.equal(retry.ok, true);
    const blocked = await other.timeout(3000).emitWithAck('message:send', message); assert.equal(blocked.ok, false); limited(blocked.error);
    assert.equal(await db.message.count({ where: { channelId: channel.id } }), 28);
    now += 9999; limited((await other.timeout(3000).emitWithAck('message:send', message)).error);
    now += 1; assert.equal((await other.timeout(3000).emitWithAck('message:send', message)).ok, true);
    assert.equal(await db.message.count({ where: { channelId: channel.id } }), 28);
    const server = app.get(ChatGateway).server;
    for (const transport of ['polling', 'websocket']) {
      const oversized = client(otherCookie, transport); assert.equal(await connect(oversized), null);
      const gone = new Promise<void>(resolve => oversized.once('disconnect', () => resolve()));
      const serverGone = new Promise<void>(resolve => server.of('/').sockets.get(oversized.id!)!.once('disconnect', () => resolve()));
      oversized.emit('message:send', { ...message, body: 'x'.repeat(17000) }); await Promise.all([gone, serverGone]);
      assert.equal(await db.message.count({ where: { channelId: channel.id } }), 28);
    }
    // Over-quota traffic must receive its ack even while the accepted channel work is held.
    now += 10000;
    const connections = app.get(ConnectionsService), coordinate = connections.withChannel.bind(connections);
    let resume!: () => void; const queueGate = new Promise<void>(resolve => { resume = resolve; });
    const held = mock.method(connections, 'withChannel', async <T>(id: string, operation: () => Promise<T>) => { await queueGate; return coordinate(id, operation); });
    try {
      const burst = Array.from({ length: 31 }, () => replacement.timeout(3000).emitWithAck('message:send', { ...message, clientMessageId: randomUUID() }));
      const rejected = await burst[30]!; assert.equal(rejected.ok, false); limited(rejected.error);
      assert.equal(await db.message.count({ where: { channelId: channel.id } }), 28);
      resume(); for (const ack of await Promise.all(burst.slice(0, 30))) assert.equal(ack.ok, true);
      assert.equal(await db.message.count({ where: { channelId: channel.id } }), 58);
    } finally { resume(); held.mock.restore(); }
    for (let i = 0; i < 10; i++) {
      const currentCookie = i % 2 ? otherCookie : cookie;
      const csrf = await (await fetch(`${endpoint}/api/auth/session/csrf`, { headers: { origin, cookie: currentCookie } })).json() as { csrfToken: string };
      assert.equal((await post('channels', '{}', { ...preauth, cookie: currentCookie, 'x-csrf-token': csrf.csrfToken })).status, 400);
    }
    const csrf = await (await fetch(`${endpoint}/api/auth/session/csrf`, { headers: { origin, cookie } })).json() as { csrfToken: string };
    const channelBlocked = await post('channels', '{}', { ...preauth, cookie, 'x-csrf-token': csrf.csrfToken }); assert.equal(channelBlocked.status, 429); limited(await channelBlocked.json());
    assert.equal(await db.channel.count({ where: { createdBy: user.id } }), 1);
  } finally {
    clock.mock.restore(); for (const socket of sockets) socket.disconnect();
    await db.message.deleteMany({ where: { authorId: { in: users } } });
    await db.membership.deleteMany({ where: { userId: { in: users } } });
    await db.channel.deleteMany({ where: { createdBy: { in: users } } });
    await db.session.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } }); await app.close();
  }
  // A trusted immediate proxy distinguishes clients and walks XFF only to the first untrusted hop.
  const { app: proxied } = await createApp({ NODE_ENV: 'test', PORT: '3000', DATABASE_URL: databaseUrl, TRUSTED_PROXY_IPS: '127.0.0.1' });
  try {
    await proxied.listen(0, '127.0.0.1'); const url = await proxied.getUrl();
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${url}/api/auth/register`, { method: 'POST', headers: { origin, 'x-forwarded-for': '192.0.2.1' } })).status, 403);
    assert.equal((await fetch(`${url}/api/auth/register`, { method: 'POST', headers: { origin, 'x-forwarded-for': '192.0.2.1' } })).status, 429);
    assert.equal((await fetch(`${url}/api/auth/register`, { method: 'POST', headers: { origin, 'x-forwarded-for': '192.0.2.2' } })).status, 403);
    assert.equal((await fetch(`${url}/api/auth/register`, { method: 'POST', headers: { origin, 'x-forwarded-for': '198.51.100.1, 192.0.2.1' } })).status, 429);
  } finally { await proxied.close(); }
}
