import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { MessageSyncPage } from '@real-time-chat/contracts/messages';
import { DatabaseService } from '../../src/database/database.service.js';
import { hashPassword } from '../../src/identity/password.js';
import { SessionService } from '../../src/identity/session.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { SendMessageService } from '../../src/messaging/send-message.service.js';
import { historyCursor } from '../../src/messaging/history-cursor.js';

export async function verifyMessageSync(app: INestApplication, db: DatabaseService): Promise<void> {
  const suffix = randomUUID(), password = 'a sync integration passphrase';
  const passwordHash = await hashPassword(password);
  const users = await Promise.all([0, 1].map(i => db.user.create({ data: { email: `sync-${i}-${suffix}@example.test`, displayName: `Sync ${i}`, passwordHash } })));
  const owner = users[0]!, outsider = users[1]!;
  const sessions = app.get(SessionService), channels = app.get(ChannelsService), messages = app.get(SendMessageService);
  try {
    const cookie = (await sessions.login({ email: owner.email, password })).cookie.split(';')[0]!;
    const otherCookie = (await sessions.login({ email: outsider.email, password })).cookie.split(';')[0]!;
    const channel = (await channels.create(owner.id, { name: `Sync ${suffix}`, slug: `sync-${suffix}` })).channel;
    const empty = (await channels.create(owner.id, { name: `Empty ${suffix}`, slug: `sync-empty-${suffix}` })).channel;
    const endpoint = await app.getUrl();
    const cursor = (sequence: bigint, id = channel.id) => historyCursor(id, sequence, sequence);
    const get = (query: string, id = channel.id, auth = cookie) => fetch(`${endpoint}/api/channels/${id}/messages/sync?${query}`, { headers: { cookie: auth } });
    const page = async (query: string, id = channel.id): Promise<MessageSyncPage> => {
      const response = await get(query, id); assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json() as Promise<MessageSyncPage>;
    };
    const zero = `after=${cursor(0n)}`;
    assert.equal((await get(zero, channel.id, '')).status, 401);
    assert.equal((await get(zero, channel.id, otherCookie)).status, 403);
    const missing = randomUUID();
    assert.equal((await get(`after=${cursor(0n, missing)}`, missing)).status, 404);
    assert.equal((await get(zero, 'invalid')).status, 400);
    assert.deepEqual(await page(`after=${cursor(0n, empty.id)}`, empty.id), { items: [], nextCursor: cursor(0n, empty.id), until: cursor(0n, empty.id), hasMore: false });
    await db.$transaction(async tx => {
      await tx.message.createMany({ data: Array.from({ length: 105 }, (_, i) => ({ channelId: channel.id, authorId: owner.id,
        clientMessageId: randomUUID(), sequence: BigInt(i + 1), body: `Sync ${i + 1}`, createdAt: new Date('2026-10-13T00:00:00Z') })) });
      await tx.channel.update({ where: { id: channel.id }, data: { lastSequence: 105n } });
    });
    const first = await page(zero); assert.equal(first.items.length, 50); assert.equal(first.until, cursor(105n));
    for (const after of [first.nextCursor, cursor(104n)]) {
      const denied = await get(`after=${after}&until=${first.until}`, channel.id, otherCookie);
      assert.equal(denied.status, 403);
      assert.ok(!(await denied.text()).includes('Sync 105'));
    }
    assert.equal(first.nextCursor, cursor(50n)); assert.equal(first.hasMore, true);
    const all = [...first.items]; let current = first, pages = 1;
    while (current.hasMore) {
      assert.ok(pages < 4, 'fixed H must terminate despite new writes');
      await messages.send(owner.id, { channelId: channel.id, clientMessageId: randomUUID(), body: 'Traffic after H' });
      current = await page(`after=${current.nextCursor}&until=${first.until}`); pages++;
      assert.equal(current.until, first.until); all.push(...current.items);
    }
    assert.equal(pages, 3); assert.equal(current.nextCursor, first.until);
    assert.deepEqual(all.map(item => item.sequence), Array.from({ length: 105 }, (_, i) => String(i + 1)));
    assert.equal(new Set(all.map(item => item.id)).size, 105);
    assert.deepEqual(Object.keys(all[0]!).sort(), ['author', 'body', 'channelId', 'clientMessageId', 'createdAt', 'id', 'sequence']);
    assert.deepEqual(await page(`after=${first.until}&until=${first.until}`), { items: [], nextCursor: first.until, until: first.until, hasMore: false });
    const next = await page(`after=${first.until}`); assert.deepEqual(next.items.map(item => item.sequence), ['106', '107']);
    assert.deepEqual(await page(`after=${first.nextCursor}&until=${first.until}&limit=100`),
      { items: all.slice(50), nextCursor: first.until, until: first.until, hasMore: false });
    const snapshot = await (await fetch(`${endpoint}/api/channels/${channel.id}/messages`, { headers: { cookie } })).json();
    assert.equal((await page(`after=${snapshot.snapshotCursor}`)).items.length, 0);
    for (const query of ['', 'after=bad', `${zero}&limit=101`, `${zero}&limit=1&limit=2`, `${zero}&before=x`,
      `after=${cursor(108n)}`, `${zero}&until=${cursor(108n)}`, `after=${cursor(2n)}&until=${cursor(1n)}`,
      `after=${historyCursor(channel.id, 50n, 105n)}`, `after=${cursor(0n, empty.id)}`]) assert.equal((await get(query)).status, 400);
    await channels.setMembership(owner.id, channel.id, false);
    assert.equal((await get(`after=${first.nextCursor}&until=${first.until}`)).status, 403);
    const session = await sessions.authenticate(cookie); await sessions.revoke(session.id);
    assert.equal((await get(`after=${cursor(0n, empty.id)}`, empty.id)).status, 401);
  } finally {
    const ids = users.map(user => user.id);
    await db.message.deleteMany({ where: { authorId: { in: ids } } });
    await db.membership.deleteMany({ where: { userId: { in: ids } } });
    await db.channel.deleteMany({ where: { createdBy: { in: ids } } });
    await db.session.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}
