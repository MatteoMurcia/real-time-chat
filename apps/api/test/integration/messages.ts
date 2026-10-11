import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { isApiError } from '@real-time-chat/contracts';
import type { PublicMessage, SendMessageAck } from '@real-time-chat/contracts/messages';
import { DatabaseService } from '../../src/database/database.service.js';
import { SessionService } from '../../src/identity/session.service.js';
import { hashPassword } from '../../src/identity/password.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { SendMessageService } from '../../src/messaging/send-message.service.js';

export async function verifyMessages(app: INestApplication, db: DatabaseService): Promise<void> {
  const suffix = randomUUID(), password = 'a message integration passphrase';
  const passwordHash = await hashPassword(password);
  const users = await Promise.all([0, 1, 2].map(i => db.user.create({ data: { email: `message-${i}-${suffix}@example.test`, displayName: `Message user ${i}`, passwordHash } })));
  const sessions = app.get(SessionService), channels = app.get(ChannelsService);
  const sockets: Socket[] = [], cookies: string[] = [];
  const accepted = (ack: SendMessageAck): PublicMessage => { assert.equal(ack.ok, true); return ack.data; };
  const rejected = (ack: SendMessageAck, code: string) => { assert.equal(ack.ok, false); if (!ack.ok) { assert.ok(isApiError(ack.error)); assert.equal(ack.error.code, code); } };
  try {
    const endpoint = await app.getUrl();
    for (const user of users) {
      const cookie = (await sessions.login({ email: user.email, password })).cookie.split(';')[0]!;
      cookies.push(cookie);
      const socket = io(endpoint, { autoConnect: false, reconnection: false, timeout: 3000, transports: ['websocket'], extraHeaders: { origin: 'http://127.0.0.1:8080', cookie } });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    }
    const [sender, receiver, outsider] = sockets as [Socket, Socket, Socket];
    const channel = (await channels.create(users[0]!.id, { name: `Messages ${suffix}`, slug: `messages-${suffix}` })).channel;
    await channels.setMembership(users[1]!.id, channel.id, true);
    for (const socket of [sender, receiver]) assert.equal((await socket.timeout(3000).emitWithAck('channel:subscribe', { channelId: channel.id })).ok, true);
    const events: PublicMessage[] = [], outsideEvents: unknown[] = [];
    receiver.on('message:created', message => events.push(message));
    outsider.on('message:created', message => outsideEvents.push(message));
    const input = { channelId: channel.id, clientMessageId: randomUUID(), body: '  Hello 🌍\n<script>plain text</script>  ' };
    const send = (value: unknown = input, socket = sender): Promise<SendMessageAck> => socket.timeout(3000).emitWithAck('message:send', value);
    const flush = async () => { await receiver.timeout(3000).emitWithAck('channel:subscribe', { channelId: channel.id }); };
    rejected(await send(input, outsider), 'FORBIDDEN');
    rejected(await send({ ...input, authorId: users[1]!.id }), 'VALIDATION_ERROR');
    const replies = (await Promise.all(Array.from({ length: 5 }, () => send()))).map(accepted);
    assert.ok(replies.every(message => message.id === replies[0]!.id));
    assert.equal(replies[0]!.sequence, '1'); assert.equal(replies[0]!.body, input.body);
    assert.deepEqual(replies[0]!.author, { id: users[0]!.id, displayName: users[0]!.displayName });
    assert.deepEqual(Object.keys(replies[0]!).sort(), ['author', 'body', 'channelId', 'clientMessageId', 'createdAt', 'id', 'sequence']);
    assert.ok(await db.message.findUnique({ where: { id: replies[0]!.id } }));
    await flush(); assert.deepEqual(events, [replies[0]]); assert.deepEqual(outsideEvents, []);
    rejected(await send({ ...input, body: 'changed content' }), 'CONFLICT');
    const ordered = (await Promise.all(Array.from({ length: 5 }, (_, i) => send({ ...input, clientMessageId: randomUUID(), body: `Ordered ${i}` })))).map(accepted);
    assert.deepEqual(ordered.map(message => message.sequence), ['2', '3', '4', '5', '6']);
    await flush(); assert.deepEqual(events.map(message => message.sequence), ['1', '2', '3', '4', '5', '6']);
    assert.equal((await db.channel.findUniqueOrThrow({ where: { id: channel.id } })).lastSequence, 6n);

    // A deferred trigger fails at COMMIT, after the message insert and sequence update succeeded.
    await db.$executeRawUnsafe(`CREATE FUNCTION test_message_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private commit detail'; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE CONSTRAINT TRIGGER test_message_commit_failure AFTER INSERT ON "Message" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_message_commit_failure()');
    const retry = { ...input, clientMessageId: randomUUID(), body: 'Retry after rollback' };
    try {
      const result = await send(retry); rejected(result, 'INTERNAL_ERROR');
      assert.ok(!JSON.stringify(result).includes('private commit detail'));
      assert.equal(await db.message.count({ where: { channelId: channel.id } }), 6);
      assert.equal((await db.channel.findUniqueOrThrow({ where: { id: channel.id } })).lastSequence, 6n);
      await flush(); assert.equal(events.length, 6);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER test_message_commit_failure ON "Message"');
      await db.$executeRawUnsafe('DROP FUNCTION test_message_commit_failure()');
    }
    const recovered = accepted(await send(retry)); assert.equal(recovered.sequence, '7');
    assert.deepEqual(accepted(await send(retry)), recovered);
    const independent = (await channels.create(users[0]!.id, { name: `Concurrent ${suffix}`, slug: `concurrent-${suffix}` })).channel;
    rejected(await send({ ...input, channelId: independent.id }), 'CONFLICT');
    const persistence = app.get(SendMessageService);
    const concurrent = { ...input, channelId: independent.id, clientMessageId: randomUUID() };
    const concurrentResults = await Promise.all(Array.from({ length: 3 }, () => persistence.send(users[0]!.id, concurrent)));
    assert.equal(concurrentResults.filter(result => result.created).length, 1);
    assert.ok(concurrentResults.every(result => result.message.id === concurrentResults[0]!.message.id));
    const independentSends = await Promise.all(Array.from({ length: 4 }, () => persistence.send(users[0]!.id, { ...concurrent, clientMessageId: randomUUID() })));
    assert.deepEqual(independentSends.map(result => Number(result.message.sequence)).sort(), [2, 3, 4, 5]);
    const invalidRow = { channelId: independent.id, authorId: users[0]!.id, clientMessageId: randomUUID(), sequence: 0n, body: 'invalid' };
    await assert.rejects(db.message.create({ data: invalidRow }));
    await assert.rejects(db.message.create({ data: { ...invalidRow, sequence: 6n, body: '' } }));
    await assert.rejects(db.message.create({ data: { ...invalidRow, sequence: 1n } }), { code: 'P2002' });
    const unicode = accepted(await send({ ...input, clientMessageId: randomUUID(), body: '🌍'.repeat(2000) }));
    assert.equal(unicode.body, '🌍'.repeat(2000));
    const sameKeyOtherAuthor = accepted(await send(input, receiver));
    assert.notEqual(sameKeyOtherAuthor.id, replies[0]!.id);
    await channels.setMembership(users[0]!.id, channel.id, false);
    rejected(await send(), 'FORBIDDEN');
    rejected(await send({ ...input, clientMessageId: randomUUID() }), 'FORBIDDEN');
    const current = await sessions.authenticate(cookies[1]);
    await sessions.revoke(current.id);
    rejected(await send({ ...input, clientMessageId: randomUUID() }, receiver), 'UNAUTHENTICATED');
    const beforeRevokedDelivery = events.length;
    await channels.setMembership(users[2]!.id, channel.id, true);
    await outsider.timeout(3000).emitWithAck('channel:subscribe', { channelId: channel.id });
    const expired = await sessions.authenticate(cookies[2]);
    await db.session.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
    await db.channel.update({ where: { id: channel.id }, data: { lastSequence: 9007199254740992n } });
    await channels.setMembership(users[0]!.id, channel.id, true);
    assert.equal(accepted(await send({ ...input, clientMessageId: randomUUID() })).sequence, '9007199254740993');
    await receiver.timeout(3000).emitWithAck('channel:unsubscribe', { channelId: channel.id });
    assert.equal(events.length, beforeRevokedDelivery);
    await outsider.timeout(3000).emitWithAck('channel:unsubscribe', { channelId: channel.id });
    assert.deepEqual(outsideEvents, []);
  } finally {
    for (const socket of sockets) socket.disconnect();
    const ids = users.map(user => user.id);
    await db.message.deleteMany({ where: { authorId: { in: ids } } });
    await db.membership.deleteMany({ where: { userId: { in: ids } } });
    await db.channel.deleteMany({ where: { createdBy: { in: ids } } });
    await db.session.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}
