import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { MessagePage } from '@real-time-chat/contracts/messages';
import { DatabaseService } from '../../src/database/database.service.js';
import { hashPassword } from '../../src/identity/password.js';
import { SessionService } from '../../src/identity/session.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { SendMessageService } from '../../src/messaging/send-message.service.js';
import { historyCursor } from '../../src/messaging/history-cursor.js';

export async function verifyHistory(app: INestApplication, db: DatabaseService): Promise<void> {
  const suffix = randomUUID(), password = 'a history integration passphrase';
  const passwordHash = await hashPassword(password);
  const users = await Promise.all([0, 1].map(i => db.user.create({ data: { email: `history-${i}-${suffix}@example.test`, displayName: `History ${i}`, passwordHash } })));
  const owner = users[0]!, outsider = users[1]!;
  const sessions = app.get(SessionService), channels = app.get(ChannelsService);
  try {
    const cookie = (await sessions.login({ email: owner.email, password })).cookie.split(';')[0]!;
    const otherCookie = (await sessions.login({ email: outsider.email, password })).cookie.split(';')[0]!;
    const channel = (await channels.create(owner.id, { name: `History ${suffix}`, slug: `history-${suffix}` })).channel;
    const empty = (await channels.create(owner.id, { name: `Empty ${suffix}`, slug: `empty-${suffix}` })).channel;
    const endpoint = await app.getUrl();
    const get = (query = '', id = channel.id, auth = cookie) => fetch(`${endpoint}/api/channels/${id}/messages${query}`, { headers: { cookie: auth } });
    const page = async (query = '', id = channel.id): Promise<MessagePage> => {
      const response = await get(query, id); assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json() as Promise<MessagePage>;
    };
    assert.equal((await get('', channel.id, '')).status, 401);
    assert.equal((await get('', channel.id, otherCookie)).status, 403);
    assert.equal((await get('', randomUUID())).status, 404);
    assert.equal((await get('', 'invalid')).status, 400);
    assert.deepEqual(await page('', empty.id), { items: [], olderCursor: null, snapshotCursor: historyCursor(empty.id, 0n, 0n) });
    const createdAt = new Date('2026-10-12T00:00:00Z');
    await db.$transaction(async tx => {
      await tx.message.createMany({ data: Array.from({ length: 105 }, (_, i) => ({ channelId: channel.id, authorId: owner.id,
        clientMessageId: randomUUID(), sequence: BigInt(i + 1), body: `History ${i + 1}`, createdAt })) });
      await tx.channel.update({ where: { id: channel.id }, data: { lastSequence: 105n } });
    });
    const first = await page(); assert.equal(first.items.length, 50);
    // A cursor is a position, never a capability: borrowing or constructing one grants no access.
    for (const before of [first.olderCursor, historyCursor(channel.id, 105n, 105n)]) {
      const denied = await get(`?before=${before}`, channel.id, otherCookie);
      assert.equal(denied.status, 403);
      assert.ok(!(await denied.text()).includes('History 105'));
    }
    assert.deepEqual(first.items.map(item => item.sequence), Array.from({ length: 50 }, (_, i) => String(i + 56)));
    assert.ok(first.items.every(item => item.createdAt === createdAt.toISOString()));
    assert.deepEqual(first.items[0]!.author, { id: owner.id, displayName: owner.displayName });
    assert.deepEqual(Object.keys(first.items[0]!).sort(), ['author', 'body', 'channelId', 'clientMessageId', 'createdAt', 'id', 'sequence']);
    await app.get(SendMessageService).send(owner.id, { channelId: channel.id, clientMessageId: randomUUID(), body: 'New after snapshot' });
    const second = await page(`?before=${first.olderCursor}`);
    const third = await page(`?before=${second.olderCursor}`);
    assert.equal(second.snapshotCursor, first.snapshotCursor); assert.equal(third.snapshotCursor, first.snapshotCursor);
    assert.equal(third.olderCursor, null);
    const all = [...third.items, ...second.items, ...first.items];
    assert.equal(new Set(all.map(item => item.id)).size, 105);
    assert.deepEqual(all.map(item => item.sequence), Array.from({ length: 105 }, (_, i) => String(i + 1)));
    assert.deepEqual(await page(`?before=${first.olderCursor}`), second);
    assert.equal((await page('?limit=100')).items.length, 100);
    assert.equal((await page('?limit=1')).items[0]!.sequence, '106');
    for (const query of ['?limit=101', '?limit=1&limit=2', '?before=invalid', '?after=1', '?unknown=x',
      `?before=${historyCursor(channel.id, 1n, 107n)}`]) assert.equal((await get(query)).status, 400);
    assert.equal((await get(`?before=${first.olderCursor}`, empty.id)).status, 400);
    await channels.setMembership(owner.id, channel.id, false);
    assert.equal((await get(`?before=${first.olderCursor}`)).status, 403);
    const current = await sessions.authenticate(cookie); await sessions.revoke(current.id);
    assert.equal((await get('', empty.id)).status, 401);
  } finally {
    const ids = users.map(user => user.id);
    await db.message.deleteMany({ where: { authorId: { in: ids } } });
    await db.membership.deleteMany({ where: { userId: { in: ids } } });
    await db.channel.deleteMany({ where: { createdBy: { in: ids } } });
    await db.session.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}
