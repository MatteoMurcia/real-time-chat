import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { isApiError } from '@real-time-chat/contracts';
import type { ChannelSubscriptionAck } from '@real-time-chat/contracts/channels';
import { DatabaseService } from '../../src/database/database.service.js';
import { SessionService } from '../../src/identity/session.service.js';
import { hashPassword } from '../../src/identity/password.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { ChannelAccessService } from '../../src/channels/channel-access.service.js';
import { ChatGateway } from '../../src/realtime/chat.gateway.js';
import { ConnectionsService } from '../../src/realtime/connections.service.js';

export async function verifySubscriptions(app: INestApplication, db: DatabaseService): Promise<void> {
  const suffix = randomUUID();
  const password = 'subscription integration passphrase';
  const passwordHash = await hashPassword(password);
  const users = await Promise.all([0, 1].map(i => db.user.create({ data: { email: `subscribe-${i}-${suffix}@example.test`, displayName: 'Socket member', passwordHash } })));
  const sessions = app.get(SessionService), channels = app.get(ChannelsService), access = app.get(ChannelAccessService);
  const connections = app.get(ConnectionsService), server = app.get(ChatGateway).server;
  const endpoint = await app.getUrl(), origin = 'http://127.0.0.1:8080';
  const sockets: Socket[] = [];
  const connect = async (cookie: string) => {
    const socket = io(endpoint, { autoConnect: false, reconnection: false, timeout: 3000, transports: ['websocket'], extraHeaders: { origin, cookie } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    return socket;
  };
  const ack = (socket: Socket, event: string, payload: unknown): Promise<ChannelSubscriptionAck> => socket.timeout(3000).emitWithAck(event, payload);
  const rejected = (result: ChannelSubscriptionAck, code: string) => {
    assert.equal(result.ok, false);
    if (!result.ok) { assert.ok(isApiError(result.error)); assert.equal(result.error.code, code); }
  };
  try {
    const cookie = (await sessions.login({ email: users[0]!.email, password })).cookie.split(';')[0]!;
    const otherCookie = (await sessions.login({ email: users[1]!.email, password })).cookie.split(';')[0]!;
    const { channel } = await channels.create(users[0]!.id, { name: `Subscriptions ${suffix}`, slug: `sub-${suffix}` });
    const secondChannel = (await channels.create(users[0]!.id, { name: `Other ${suffix}`, slug: `other-${suffix}` })).channel;
    const [first, second, outsider] = await Promise.all([connect(cookie), connect(cookie), connect(otherCookie)]);
    const room = `channel:${channel.id}`;
    const hasRoom = (socket: Socket) => server.of('/').sockets.get(socket.id!)?.rooms.has(room) ?? false;
    const subscribe = (socket = first) => ack(socket, 'channel:subscribe', { channelId: channel.id });
    const csrf = await (await fetch(`${endpoint}/api/auth/session/csrf`, { headers: { cookie, origin } })).json() as { csrfToken: string };
    const leave = () => fetch(`${endpoint}/api/channels/${channel.id}/membership`, { method: 'DELETE', headers: { cookie, origin, 'x-csrf-token': csrf.csrfToken } });
    rejected(await subscribe(outsider), 'FORBIDDEN');
    assert.equal(await db.membership.count({ where: { userId: users[1]!.id } }), 0);
    for (const payload of [null, [], {}, { channelId: 'bad' }, { channelId: channel.id, userId: users[0]!.id }]) {
      rejected(await ack(first, 'channel:subscribe', payload), 'VALIDATION_ERROR');
    }
    rejected(await ack(first, 'channel:subscribe', { channelId: randomUUID() }), 'NOT_FOUND');
    for (const socket of [first, first, second]) {
      assert.deepEqual(await subscribe(socket), { ok: true, data: { channelId: channel.id, subscribed: true } });
      assert.equal(hasRoom(socket), true);
    }
    await ack(first, 'channel:subscribe', { channelId: secondChannel.id });
    assert.equal(hasRoom(first), false);
    assert.equal(server.of('/').sockets.get(first.id!)!.rooms.has(`channel:${secondChannel.id}`), true);
    for (let i = 0; i < 2; i++) assert.deepEqual(await ack(first, 'channel:unsubscribe', { channelId: secondChannel.id }), { ok: true, data: { channelId: secondChannel.id, subscribed: false } });
    assert.equal(await db.membership.count({ where: { userId: users[0]!.id, channelId: secondChannel.id } }), 1);
    await subscribe();
    await channels.setMembership(users[1]!.id, channel.id, true);
    assert.equal((await subscribe(outsider)).ok, true);
    const databaseFailure = mock.method(access, 'lockChannel', async () => { throw new Error('private database failure'); });
    try {
      assert.equal((await leave()).status, 500);
      assert.equal(hasRoom(first), true); assert.equal(hasRoom(second), true);
      assert.equal(await db.membership.count({ where: { userId: users[0]!.id, channelId: channel.id } }), 1);
    } finally { databaseFailure.mock.restore(); }
    const notifications = [first, second].map(socket => new Promise(resolve => socket.once('channel:access-revoked', resolve)));
    assert.equal((await leave()).status, 200);
    assert.equal(hasRoom(first), false); assert.equal(hasRoom(second), false);
    assert.equal(hasRoom(outsider), true);
    assert.deepEqual(await Promise.all(notifications), [{ channelId: channel.id }, { channelId: channel.id }]);
    rejected(await subscribe(), 'FORBIDDEN');

    // Pause the first operation under the real DB lock; queue the opposite operation before releasing it.
    for (const subscribeFirst of [true, false]) {
      await channels.setMembership(users[0]!.id, channel.id, true);
      let entered!: () => void, release!: () => void, queued!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const waiting = new Promise<void>(resolve => { queued = resolve; });
      const lock = access.lockChannel.bind(access), coordinate = connections.withChannel.bind(connections);
      let locks = 0, operations = 0;
      const lockMock = mock.method(access, 'lockChannel', async (...args: Parameters<typeof lock>) => { await lock(...args); if (++locks === 1) { entered(); await held; } });
      const queueMock = mock.method(connections, 'withChannel', (...args: Parameters<typeof coordinate>) => { if (++operations === 2) queued(); return coordinate(...args); });
      try {
        const firstOperation = subscribeFirst ? subscribe() : leave();
        await started;
        const secondOperation = subscribeFirst ? leave() : subscribe();
        await waiting; release();
        const results = await Promise.all([firstOperation, secondOperation]);
        const subscription = results[subscribeFirst ? 0 : 1] as ChannelSubscriptionAck;
        if (subscribeFirst) assert.equal(subscription.ok, true); else rejected(subscription, 'FORBIDDEN');
        assert.equal((results[subscribeFirst ? 1 : 0] as Response).status, 200);
        assert.equal(hasRoom(first), false); assert.equal(hasRoom(second), false);
      } finally { release(); lockMock.mock.restore(); queueMock.mock.restore(); }
    }
    await channels.setMembership(users[0]!.id, channel.id, true);
    const failure = mock.method(access, 'requireMember', async () => { throw new Error('private database detail'); });
    try {
      const result = await subscribe(); rejected(result, 'INTERNAL_ERROR');
      assert.ok(!JSON.stringify(result).includes('private database detail')); assert.equal(hasRoom(first), false);
    } finally { failure.mock.restore(); }
    await subscribe();
    const id = first.id!;
    const disconnected = new Promise(resolve => server.of('/').sockets.get(id)!.once('disconnect', resolve));
    first.disconnect(); await disconnected;
    assert.equal(server.of('/').adapter.rooms.get(room)?.has(id) ?? false, false);
    const reconnected = await connect(cookie);
    assert.equal(hasRoom(reconnected), false);
    assert.equal((await subscribe(reconnected)).ok, true);
    const ended = new Promise(resolve => second.once('disconnect', resolve));
    await sessions.revoke((await sessions.authenticate(cookie)).id); await ended;
    assert.equal(second.connected, false); assert.equal(hasRoom(second), false);
    const otherSession = await sessions.authenticate(otherCookie);
    await db.session.update({ where: { id: otherSession.id }, data: { expiresAt: new Date(0) } });
    rejected(await subscribe(outsider), 'UNAUTHENTICATED');
  } finally {
    for (const socket of sockets) socket.disconnect();
    const ids = users.map(user => user.id);
    await db.membership.deleteMany({ where: { userId: { in: ids } } });
    await db.channel.deleteMany({ where: { createdBy: { in: ids } } });
    await db.session.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}
