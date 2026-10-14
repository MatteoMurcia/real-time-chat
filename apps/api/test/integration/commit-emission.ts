import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import type { MessageSyncPage, PublicMessage, SendMessageAck } from '@real-time-chat/contracts/messages';
import { DatabaseService } from '../../src/database/database.service.js';
import { hashPassword } from '../../src/identity/password.js';
import { SessionService } from '../../src/identity/session.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { ChatGateway } from '../../src/realtime/chat.gateway.js';
import { historyCursor } from '../../src/messaging/history-cursor.js';
import { suppressMessageEmission } from '../fixtures/message-emitter.js';

export async function verifyCommitEmissionGap(app: INestApplication, db: DatabaseService): Promise<void> {
  const suffix = randomUUID(), password = 'a commit emission passphrase', passwordHash = await hashPassword(password);
  const users = await Promise.all([0, 1].map(i => db.user.create({ data: {
    email: `gap-${i}-${suffix}@example.test`, displayName: `Gap ${i}`, passwordHash,
  } })));
  const sockets: Socket[] = [], cookies: string[] = [], endpoint = await app.getUrl();
  let suppression: ReturnType<typeof suppressMessageEmission> | undefined;
  try {
    for (const user of users) {
      const cookie = (await app.get(SessionService).login({ email: user.email, password })).cookie.split(';')[0]!;
      cookies.push(cookie);
      const socket = io(endpoint, { autoConnect: false, reconnection: false, transports: ['websocket'],
        extraHeaders: { origin: 'http://127.0.0.1:8080', cookie } });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    }
    const [sender, receiver] = sockets as [Socket, Socket], receiverId = receiver.id;
    const channels = app.get(ChannelsService);
    const channel = (await channels.create(users[0]!.id, { name: `Gap ${suffix}`, slug: `gap-${suffix}` })).channel;
    await channels.setMembership(users[1]!.id, channel.id, true);
    const barrier = async (socket = receiver) => {
      assert.equal((await socket.timeout(3000).emitWithAck('channel:subscribe', { channelId: channel.id })).ok, true);
    };
    await barrier(sender); await barrier();
    const events: PublicMessage[] = []; receiver.on('message:created', message => events.push(message));
    const key = randomUUID(); suppression = suppressMessageEmission(app.get(ChatGateway).server, key);
    const send = async (clientMessageId = randomUUID()): Promise<PublicMessage> => {
      const ack: SendMessageAck = await sender.timeout(3000).emitWithAck('message:send', { channelId: channel.id, clientMessageId, body: 'Committed message' });
      assert.equal(ack.ok, true); return ack.data;
    };
    const gap = await send(key);
    const stored = await db.message.findUniqueOrThrow({ where: { id: gap.id } });
    assert.equal(stored.clientMessageId, key); assert.equal(stored.sequence.toString(), gap.sequence);
    assert.deepEqual(suppression.suppressed.map(message => message.id), [gap.id, gap.id]);
    await barrier(); assert.equal(events.length, 0);
    const live = await Promise.all([send(), send(), send()]); await barrier();
    assert.deepEqual(events.map(message => message.id), live.map(message => message.id));
    const cursor = (sequence: bigint) => historyCursor(channel.id, sequence, sequence);
    const recover = async (after: string, until?: string): Promise<MessageSyncPage> => {
      const query = new URLSearchParams({ after, limit: '2', ...(until ? { until } : {}) });
      const response = await fetch(`${endpoint}/api/channels/${channel.id}/messages/sync?${query}`, { headers: { cookie: cookies[1]! } });
      assert.equal(response.status, 200); return response.json() as Promise<MessageSyncPage>;
    };
    const first = await recover(cursor(0n));
    assert.equal(first.until, cursor(4n)); assert.equal(first.hasMore, true);
    assert.deepEqual(first.items.map(message => message.id), [gap.id, live[0]!.id]);
    const afterH = await Promise.all([send(), send()]);
    const last = await recover(first.nextCursor, first.until);
    assert.equal(last.until, first.until); assert.equal(last.nextCursor, first.until); assert.equal(last.hasMore, false);
    assert.deepEqual(last.items.map(message => message.id), live.slice(1).map(message => message.id));
    assert.deepEqual(await recover(cursor(0n), first.until), first);
    const next = await recover(last.nextCursor);
    assert.deepEqual(next.items.map(message => message.id), afterH.map(message => message.id));
    assert.equal(next.hasMore, false); assert.equal(next.nextCursor, cursor(6n));
    assert.deepEqual(await recover(next.nextCursor), { items: [], hasMore: false, nextCursor: cursor(6n), until: cursor(6n) });
    assert.equal((await send(key)).id, gap.id); await barrier();
    assert.equal(suppression.suppressed.length, 2); // Idempotent retry does not publish again.
    assert.equal(events.some(message => message.id === gap.id), false);
    assert.equal(await db.message.count({ where: { channelId: channel.id } }), 6);
    assert.equal(receiver.connected, true); assert.equal(receiver.id, receiverId);
  } finally {
    suppression?.restore(); for (const socket of sockets) socket.disconnect();
    const ids = users.map(user => user.id);
    await db.message.deleteMany({ where: { authorId: { in: ids } } });
    await db.membership.deleteMany({ where: { userId: { in: ids } } });
    await db.channel.deleteMany({ where: { createdBy: { in: ids } } });
    await db.session.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}
