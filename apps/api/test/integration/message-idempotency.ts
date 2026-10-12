import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConflictException, type INestApplication } from '@nestjs/common';
import { DatabaseService } from '../../src/database/database.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { ChannelAccessService } from '../../src/channels/channel-access.service.js';
import { SendMessageService } from '../../src/messaging/send-message.service.js';

export async function verifyMessageIdempotency(app: INestApplication, db: DatabaseService): Promise<void> {
  const suffix = randomUUID();
  const user = await db.user.create({ data: { email: `retry-${suffix}@example.test`, displayName: 'Retry author', passwordHash: 'test-only-hash' } });
  const channels = app.get(ChannelsService), access = app.get(ChannelAccessService);
  try {
    const first = (await channels.create(user.id, { name: `First ${suffix}`, slug: `first-${suffix}` })).channel;
    const second = (await channels.create(user.id, { name: `Second ${suffix}`, slug: `second-${suffix}` })).channel;
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
    let results: PromiseSettledResult<Awaited<ReturnType<typeof service.send>>>[];
    try {
      results = await Promise.allSettled([service.send(user.id, input), service.send(user.id, { ...input, channelId: second.id })]);
    } finally { release(); }
    const success = results.filter(result => result.status === 'fulfilled');
    const failure = results.filter(result => result.status === 'rejected');
    assert.equal(success.length, 1, failure.map(result => String(result.reason)).join('\n')); assert.equal(failure.length, 1);
    assert.ok(failure[0]!.reason instanceof ConflictException);
    assert.equal(await db.message.count({ where: { authorId: user.id, clientMessageId: input.clientMessageId } }), 1);
    const counters = await db.channel.findMany({ where: { createdBy: user.id }, select: { lastSequence: true } });
    assert.deepEqual(counters.map(row => row.lastSequence).sort(), [0n, 1n]);
  } finally {
    await db.message.deleteMany({ where: { authorId: user.id } });
    await db.membership.deleteMany({ where: { userId: user.id } });
    await db.channel.deleteMany({ where: { createdBy: user.id } });
    await db.user.delete({ where: { id: user.id } });
  }
}
