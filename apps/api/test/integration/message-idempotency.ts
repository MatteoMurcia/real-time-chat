import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { ConflictException, ForbiddenException, type INestApplication } from '@nestjs/common';
import { DatabaseService } from '../../src/database/database.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { ChannelAccessService } from '../../src/channels/channel-access.service.js';
import { SendMessageService } from '../../src/messaging/send-message.service.js';

export async function verifyMessageIdempotency(app: INestApplication, db: DatabaseService): Promise<void> {
  const suffix = randomUUID();
  const user = await db.user.create({ data: { email: `retry-${suffix}@example.test`, displayName: 'Retry author', passwordHash: 'test-only-hash' } });
  const channels = app.get(ChannelsService), access = app.get(ChannelAccessService);
  try {
    for (const revoke of [false, true]) {
      const first = (await channels.create(user.id, { name: `First ${revoke} ${suffix}`, slug: `a-${Number(revoke)}-${suffix}` })).channel;
      const second = (await channels.create(user.id, { name: `Second ${revoke} ${suffix}`, slug: `b-${Number(revoke)}-${suffix}` })).channel;
      const input = { channelId: first.id, clientMessageId: randomUUID(), body: 'Concurrent key' };
      let release!: () => void, reads = 0;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      // Both real transactions must observe the absent key before either inserts it.
      const concurrentDb = db.$extends({ query: { message: {
        async findUnique({ args, query }) {
          const row = await query(args);
          if (++reads <= 2) { if (reads === 2) release(); await barrier; }
          return row;
        },
      } } });
      const service = new SendMessageService(concurrentDb as unknown as DatabaseService, access);
      const lock = access.lockChannel.bind(access); let locks = 0;
      const lockMock = mock.method(access, 'lockChannel', async (...[tx, channelId]: Parameters<typeof lock>) => {
        // The third lock is the recovery transaction; leave commits before it acquires the lock.
        if (++locks === 3 && revoke) await channels.setMembership(user.id, channelId, false);
        await lock(tx, channelId);
      });
      let results: PromiseSettledResult<Awaited<ReturnType<typeof service.send>>>[];
      try {
        results = await Promise.allSettled([service.send(user.id, input), service.send(user.id, { ...input, channelId: second.id })]);
      } finally { release(); lockMock.mock.restore(); }
      const success = results.filter(result => result.status === 'fulfilled');
      const failure = results.filter(result => result.status === 'rejected');
      assert.equal(success.length, 1, failure.map(result => String(result.reason)).join('\n')); assert.equal(failure.length, 1);
      assert.ok(failure[0]!.reason instanceof (revoke ? ForbiddenException : ConflictException));
      assert.equal(await db.message.count({ where: { authorId: user.id, clientMessageId: input.clientMessageId } }), 1);
      const counters = await db.channel.findMany({ where: { id: { in: [first.id, second.id] } }, select: { lastSequence: true } });
      assert.deepEqual(counters.map(row => row.lastSequence).sort(), [0n, 1n]);
      if (!revoke) {
        const winner = success[0]!.value.message;
        // An unrelated sequence-index violation must not become a successful retry or a key conflict.
        await db.channel.update({ where: { id: winner.channelId }, data: { lastSequence: 0n } });
        await assert.rejects(service.send(user.id, { ...input, channelId: winner.channelId, clientMessageId: randomUUID() }), { code: 'P2002' });
        await db.channel.update({ where: { id: winner.channelId }, data: { lastSequence: 1n } });
      }
    }
  } finally {
    await db.message.deleteMany({ where: { authorId: user.id } });
    await db.membership.deleteMany({ where: { userId: user.id } });
    await db.channel.deleteMany({ where: { createdBy: user.id } });
    await db.user.delete({ where: { id: user.id } });
  }
}
