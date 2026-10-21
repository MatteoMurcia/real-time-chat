import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import type { TypingAck, TypingChanged } from '@real-time-chat/contracts/activity';
import { DatabaseService } from '../../src/database/database.service.js';
import { SessionService } from '../../src/identity/session.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { hashPassword } from '../../src/identity/password.js';

export async function verifyTyping(app: INestApplication, db: DatabaseService): Promise<void> {
  const suffix = randomUUID(), password = 'typing integration passphrase';
  const passwordHash = await hashPassword(password);
  const users = await Promise.all([0, 1, 2].map(i => db.user.create({ data: {
    email: `typing-${i}-${suffix}@example.test`, displayName: `Writer ${i}`, passwordHash,
  } })));
  const sessions = app.get(SessionService), channels = app.get(ChannelsService);
  const endpoint = await app.getUrl(), sockets: Socket[] = [];
  const connect = async (index: number) => {
    const cookie = (await sessions.login({ email: users[index]!.email, password })).cookie.split(';')[0]!;
    const socket = io(endpoint, { autoConnect: false, reconnection: false, transports: ['websocket'],
      extraHeaders: { origin: 'http://127.0.0.1:8080', cookie } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    return socket;
  };
  const ack = (socket: Socket, event: string, input: unknown): Promise<TypingAck> => socket.timeout(3000).emitWithAck(event, input);
  const rejected = (result: TypingAck, code: string) => { assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, code); };
  try {
    const { channel } = await channels.create(users[0]!.id, { name: `Typing ${suffix}`, slug: `typing-${suffix}` });
    await channels.setMembership(users[1]!.id, channel.id, true);
    const [sender, receiver, outsider, otherTab] = await Promise.all([connect(0), connect(1), connect(2), connect(0)]);
    const received: TypingChanged[] = [], leaked: unknown[] = [];
    receiver!.on('typing:changed', event => received.push(event)); outsider!.on('typing:changed', event => leaked.push(event));
    const input = { channelId: channel.id, typing: true };
    rejected(await ack(outsider!, 'typing:update', input), 'FORBIDDEN');
    rejected(await ack(sender!, 'typing:update', input), 'FORBIDDEN'); // Membership alone cannot publish outside the active subscription.
    for (const socket of [sender!, receiver!, otherTab!]) assert.equal((await ack(socket, 'channel:subscribe', { channelId: channel.id })).ok, true);
    for (const invalid of [{ ...input, userId: users[2]!.id }, { ...input, body: 'private draft' }, { ...input, typing: 'yes' }]) {
      rejected(await ack(sender!, 'typing:update', invalid), 'VALIDATION_ERROR');
    }
    const changed = new Promise<TypingChanged>(resolve => receiver!.once('typing:changed', resolve));
    assert.equal((await ack(sender!, 'typing:update', input)).ok, true);
    assert.deepEqual(await changed, { channelId: channel.id, connectionId: sender!.id, user: { id: users[0]!.id, displayName: users[0]!.displayName } });
    const receiverStarted = new Promise(resolve => sender!.once('typing:changed', resolve));
    assert.equal((await ack(receiver!, 'typing:update', input)).ok, true); await receiverStarted;
    const unsubscribed = new Promise<TypingChanged>(resolve => sender!.once('typing:changed', resolve));
    assert.equal((await ack(receiver!, 'channel:unsubscribe', { channelId: channel.id })).ok, true);
    assert.deepEqual(await unsubscribed, { channelId: channel.id, connectionId: receiver!.id, user: null });
    assert.equal((await ack(receiver!, 'channel:subscribe', { channelId: channel.id })).ok, true);
    const stop = new Promise<TypingChanged>(resolve => receiver!.once('typing:changed', resolve));
    assert.equal((await ack(sender!, 'typing:update', { ...input, typing: false })).ok, true);
    assert.equal((await stop).user, null);
    const renewed = new Promise(resolve => receiver!.once('typing:changed', resolve));
    assert.equal((await ack(sender!, 'typing:update', input)).ok, true); await renewed;
    const disconnected = new Promise<TypingChanged>(resolve => receiver!.once('typing:changed', resolve));
    const senderId = sender!.id; sender!.io.engine.close();
    assert.deepEqual(await disconnected, { channelId: channel.id, connectionId: senderId, user: null });
    const active = new Promise(resolve => receiver!.once('typing:changed', resolve));
    assert.equal((await ack(otherTab!, 'typing:update', input)).ok, true); await active;
    const left = new Promise<TypingChanged>(resolve => receiver!.once('typing:changed', resolve));
    await channels.setMembership(users[0]!.id, channel.id, false);
    assert.equal((await left).user, null);
    rejected(await ack(otherTab!, 'typing:update', input), 'FORBIDDEN');
    assert.equal(await db.message.count(), 0); assert.equal(await db.readCursor.count(), 0);
    assert.equal(leaked.length, 0); assert.ok(received.length >= 6);
    // Invalid attempts and both sessions spend the same per-user quota before authorization work.
    for (let i = 0; i < 10; i++) await ack(otherTab!, 'typing:update', input);
    rejected(await ack(otherTab!, 'typing:update', input), 'RATE_LIMITED');
  } finally { for (const socket of sockets) socket.disconnect(); }
}
