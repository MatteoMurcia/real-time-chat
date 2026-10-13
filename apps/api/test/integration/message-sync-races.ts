import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { DatabaseService } from '../../src/database/database.service.js';
import { ChannelAccessService } from '../../src/channels/channel-access.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { SyncService } from '../../src/messaging/sync.service.js';
import { SendMessageService } from '../../src/messaging/send-message.service.js';
import { historyCursor } from '../../src/messaging/history-cursor.js';

export async function verifySyncCommitBoundary(app: INestApplication, db: DatabaseService): Promise<void> {
  const suffix = randomUUID();
  const user = await db.user.create({ data: { email: `sync-race-${suffix}@example.test`, displayName: 'Sync race', passwordHash: 'test-only-hash' } });
  const access = app.get(ChannelAccessService), sync = app.get(SyncService), messages = app.get(SendMessageService);
  try {
    for (const rollback of [false, true]) {
      const channel = (await app.get(ChannelsService).create(user.id, { name: `Race ${rollback} ${suffix}`, slug: `sync-race-${Number(rollback)}-${suffix}` })).channel;
      const cursor = (n: bigint) => historyCursor(channel.id, n, n);
      const input = { channelId: channel.id, clientMessageId: randomUUID(), body: 'Delayed commit' };
      let release!: () => void, inserted!: (pid: number) => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<number>(resolve => { inserted = resolve; });
      const writer = db.$transaction(async tx => {
        await access.lockChannel(tx, channel.id);
        await access.requireMember(user.id, channel.id, tx);
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        assert.ok(backend);
        await tx.channel.update({ where: { id: channel.id }, data: { lastSequence: 1n } });
        await tx.message.create({ data: { ...input, authorId: user.id, sequence: 1n } });
        inserted(backend.pid); await gate;
        if (rollback) throw new Error('intentional sync rollback');
      });
      const writerResult = writer.then(() => 'committed', error => {
        assert.equal(error.message, 'intentional sync rollback'); return 'rolled back';
      });
      const pid = await Promise.race([ready, writerResult.then(() => { throw new Error('Writer ended before the barrier'); })]);
      const recovery = sync.list(user.id, channel.id, { after: cursor(0n) });
      try {
        // Observe the real PostgreSQL wait, rather than assuming a sleep made the requests overlap.
        let blocked = false;
        const deadline = Date.now() + 2000;
        while (!blocked && Date.now() < deadline) {
          const [row] = await db.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))
          ) AS blocked`;
          blocked = row!.blocked;
          if (!blocked) await setTimeout(10);
        }
        assert.equal(blocked, true, 'sync must wait for the uncommitted channel writer');
      } finally { release(); await Promise.all([writerResult, recovery]); }
      const page = await recovery;
      assert.equal(page.until, cursor(rollback ? 0n : 1n));
      assert.equal(page.nextCursor, page.until); assert.equal(page.hasMore, false);
      assert.deepEqual(page.items.map(item => item.clientMessageId), rollback ? [] : [input.clientMessageId]);
      const saved = await messages.send(user.id, { ...input, clientMessageId: randomUUID(), body: 'After boundary' });
      const next = await sync.list(user.id, channel.id, { after: page.nextCursor });
      assert.deepEqual(next.items.map(item => item.id), [saved.message.id]);
      // Boundaries and response sequences remain exact past Number.MAX_SAFE_INTEGER.
      await db.channel.update({ where: { id: channel.id }, data: { lastSequence: 9007199254740992n } });
      const high = await messages.send(user.id, { ...input, clientMessageId: randomUUID() });
      const exact = await sync.list(user.id, channel.id, { after: cursor(9007199254740992n), limit: '1' });
      assert.equal(exact.items[0]?.sequence, '9007199254740993');
      assert.equal(exact.nextCursor, cursor(9007199254740993n)); assert.equal(exact.hasMore, false);
      assert.equal(exact.items[0]?.id, high.message.id);
    }
  } finally {
    await db.message.deleteMany({ where: { authorId: user.id } });
    await db.membership.deleteMany({ where: { userId: user.id } });
    await db.channel.deleteMany({ where: { createdBy: user.id } });
    await db.user.delete({ where: { id: user.id } });
  }
}
