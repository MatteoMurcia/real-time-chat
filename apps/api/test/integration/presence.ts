import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { PRESENCE_PING_INTERVAL_MS, PRESENCE_PING_TIMEOUT_MS, type PresenceAck } from '@real-time-chat/contracts/activity';
import { DatabaseService } from '../../src/database/database.service.js';
import { SessionService } from '../../src/identity/session.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { ChannelAccessService } from '../../src/channels/channel-access.service.js';
import { ConnectionsService } from '../../src/realtime/connections.service.js';
import { ChatGateway } from '../../src/realtime/chat.gateway.js';
import { hashPassword } from '../../src/identity/password.js';

export async function verifyPresence(app: INestApplication, db: DatabaseService): Promise<void> {
  const suffix = randomUUID(), password = 'presence integration passphrase';
  const passwordHash = await hashPassword(password);
  const users = await Promise.all([0, 1, 2].map(index => db.user.create({ data: {
    email: `presence-${index}-${suffix}@example.test`, displayName: `Presence ${index}`, passwordHash,
  } })));
  const sessions = app.get(SessionService), channels = app.get(ChannelsService), connections = app.get(ConnectionsService);
  const server = app.get(ChatGateway).server, endpoint = await app.getUrl(), origin = 'http://127.0.0.1:8080';
  const sockets: Socket[] = [];
  const login = async (index: number) => {
    const cookie = (await sessions.login({ email: users[index]!.email, password })).cookie.split(';')[0]!;
    return { cookie, session: await sessions.authenticate(cookie) };
  };
  const connect = async (cookie: string) => {
    const socket = io(endpoint, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { origin, cookie } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    return socket;
  };
  const ack = (socket: Socket, body: unknown): Promise<PresenceAck> => socket.timeout(3000).emitWithAck('presence:get', body);
  const rejected = (response: PresenceAck, code: string) => { assert.equal(response.ok, false); if (!response.ok) assert.equal(response.error.code, code); };
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!condition() && Date.now() < deadline) await delay(10);
    assert.equal(condition(), true);
  };
  try {
    const { channel } = await channels.create(users[0]!.id, { name: `Presence ${suffix}`, slug: `presence-${suffix}` });
    await channels.setMembership(users[1]!.id, channel.id, true);
    const [reader, writer, independent, outsider] = await Promise.all([login(0), login(1), login(1), login(2)]);
    const [observer, first, second, third, stranger] = await Promise.all([
      connect(reader.cookie), connect(writer.cookie), connect(writer.cookie), connect(independent.cookie), connect(outsider.cookie),
    ]);
    const input = { channelId: channel.id, userIds: [users[1]!.id] };
    const expected = (online: boolean) => ({ ok: true, data: { channelId: channel.id, users: [{ userId: users[1]!.id, online }] } });
    rejected(await ack(observer!, input), 'FORBIDDEN');
    rejected(await ack(stranger!, input), 'FORBIDDEN');
    assert.equal((await observer!.timeout(3000).emitWithAck('channel:subscribe', { channelId: channel.id })).ok, true);
    const valid = new Set([writer.session.id, independent.session.id]);
    await until(() => connections.countConnections(users[1]!.id, valid) === 3);
    assert.deepEqual(await ack(observer!, input), expected(true));
    for (const body of [{ ...input, viewerId: users[1]!.id }, { ...input, userIds: [] }, { ...input, userIds: Array(101).fill(users[1]!.id) }]) {
      rejected(await ack(observer!, body), 'VALIDATION_ERROR');
    }
    const empty = { ok: true, data: { channelId: channel.id, users: [] } };
    assert.deepEqual(await ack(observer!, { ...input, userIds: [users[2]!.id] }), empty);
    assert.deepEqual(await ack(observer!, { ...input, userIds: [randomUUID()] }), empty);
    const leaked: unknown[][] = []; stranger!.on('presence:changed', (...args: unknown[]) => leaked.push(args));
    const changed = new Promise<unknown[]>(resolve => observer!.once('presence:changed', (...args: unknown[]) => resolve(args)));
    first!.disconnect(); await until(() => connections.countConnections(users[1]!.id, valid) === 2);
    assert.deepEqual(await changed, []); assert.deepEqual(await ack(observer!, input), expected(true));
    const closed = new Promise(resolve => second!.once('disconnect', resolve));
    const csrf = await (await fetch(`${endpoint}/api/auth/session/csrf`, { headers: { origin, cookie: writer.cookie } })).json() as { csrfToken: string };
    assert.equal((await fetch(`${endpoint}/api/auth/logout`, { method: 'POST', headers: { origin, cookie: writer.cookie, 'x-csrf-token': csrf.csrfToken } })).status, 204);
    await closed;
    assert.equal(connections.countConnections(users[1]!.id, valid), 1);
    assert.deepEqual(await ack(observer!, input), expected(true));

    const short = await login(1);
    await db.session.update({ where: { id: short.session.id }, data: { expiresAt: new Date(Date.now() + 1500) } });
    const expiring = await connect(short.cookie);
    const expired = new Promise(resolve => expiring.once('disconnect', resolve));
    await until(() => connections.countConnections(users[1]!.id, new Set([...valid, short.session.id])) === 2);
    await expired; assert.equal(expiring.connected, false);
    assert.deepEqual(await ack(observer!, input), expected(true));

    const failure = mock.method(app.get(ChannelAccessService), 'lockChannel', async () => { throw new Error('private presence dependency failure'); });
    try { rejected(await ack(observer!, input), 'INTERNAL_ERROR'); } finally { failure.mock.restore(); }
    assert.deepEqual(await ack(observer!, input), expected(true));
    await db.session.delete({ where: { id: independent.session.id } });
    assert.equal(third!.connected, true);
    assert.deepEqual(await ack(observer!, input), expected(false)); // DB revocation overrides stale local indexing.
    third!.disconnect();
    await db.membership.delete({ where: { userId_channelId: { userId: users[0]!.id, channelId: channel.id } } });
    rejected(await ack(observer!, input), 'FORBIDDEN'); // Even an externally stale room is not authorization.
    await channels.setMembership(users[0]!.id, channel.id, true);

    const silent = await login(1), blackhole = await connect(silent.cookie);
    await until(() => connections.countConnections(users[1]!.id, new Set([silent.session.id])) === 1);
    assert.deepEqual(await ack(observer!, input), expected(true));
    assert.equal(server.engine.opts.pingInterval, PRESENCE_PING_INTERVAL_MS);
    assert.equal(server.engine.opts.pingTimeout, PRESENCE_PING_TIMEOUT_MS);
    let pings = 0; blackhole.io.engine.on('ping', () => pings++);
    const serverSocket = server.of('/').sockets.get(blackhole.id!)!;
    const timedOut = new Promise<string>(resolve => serverSocket.once('disconnect', resolve));
    // Keep the WebSocket open and suppress all outgoing frames, including Engine.IO pongs.
    blackhole.io.engine.transport.writable = false;
    const started = performance.now();
    assert.equal(await timedOut, 'ping timeout');
    const duration = performance.now() - started;
    assert.ok(pings > 0); assert.ok(duration <= PRESENCE_PING_INTERVAL_MS + PRESENCE_PING_TIMEOUT_MS + 5000);
    console.log(`Presence silent-link detection: ${Math.round(duration)} ms (real 25s/20s heartbeat).`);
    assert.deepEqual(await ack(observer!, input), expected(false));
    assert.equal(connections.countConnections(users[1]!.id, new Set([silent.session.id])), 0);
    assert.deepEqual(leaked, []);
    assert.deepEqual(await Promise.all([db.message.count(), db.readCursor.count()]), [0, 0]);
    for (let index = 0; index < 20; index++) await ack(observer!, input);
    rejected(await ack(observer!, input), 'RATE_LIMITED');
  } finally { for (const socket of sockets) socket.disconnect(); }
}
