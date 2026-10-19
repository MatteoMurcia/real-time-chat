import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { demoAccounts, seedDemo } from '../../prisma/demo-seed.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { SessionService } from '../../src/identity/session.service.js';
import { SendMessageService } from '../../src/messaging/send-message.service.js';
import type { MessagePage } from '@real-time-chat/contracts/messages';

export async function verifyDemoSeed(app: INestApplication, db: DatabaseService): Promise<void> {
  const env = { DEMO_ALICE_PASSWORD: 'isolated alice demo passphrase', DEMO_BOB_PASSWORD: 'isolated bob demo passphrase' };
  const accounts = demoAccounts(env), endpoint = await app.getUrl();
  const outsider = await db.user.create({ data: { email: `unrelated-${randomUUID()}@example.test`, displayName: 'Unrelated', passwordHash: 'untouched' } });
  const foreign = await db.channel.create({ data: { name: 'Unrelated channel', nameKey: 'unrelated channel', slug: 'unrelated-channel', createdBy: outsider.id, lastSequence: 1n } });
  await db.membership.create({ data: { userId: outsider.id, channelId: foreign.id } });
  await db.message.create({ data: { authorId: outsider.id, channelId: foreign.id, clientMessageId: randomUUID(), sequence: 1n, body: 'Keep this unrelated message' } });
  const fingerprint = async () => Promise.all([
    db.user.findMany({ orderBy: { id: 'asc' } }), db.channel.findMany({ orderBy: { id: 'asc' } }),
    db.membership.findMany({ orderBy: [{ channelId: 'asc' }, { userId: 'asc' }] }), db.message.findMany({ orderBy: { id: 'asc' } }),
  ]);
  await seedDemo(db, env);
  const original = await fingerprint();
  await Promise.all([seedDemo(db, env), seedDemo(db, env)]);
  assert.deepEqual(await fingerprint(), original, 'concurrent reruns preserve IDs, hashes, timestamps, sequences and foreign data');
  assert.equal(await db.user.count(), 3); assert.equal(await db.channel.count(), 3);
  assert.equal(await db.membership.count(), 5); assert.equal(await db.message.count(), 112);
  assert.deepEqual(await db.channel.findUnique({ where: { id: foreign.id } }), foreign);
  for (const account of accounts) {
    const login = await app.get(SessionService).login({ email: account.email, password: account.password });
    const headers = { cookie: login.cookie.split(';')[0]! };
    const channel = await db.channel.findUniqueOrThrow({ where: { slug: 'demo-lounge' } });
    let cursor: string | null = null; const ids: string[] = [], lengths: number[] = [];
    do {
      const response: Response = await fetch(`${endpoint}/api/channels/${channel.id}/messages${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`, { headers });
      assert.equal(response.status, 200);
      const page = await response.json() as MessagePage;
      ids.push(...page.items.map(item => item.id)); lengths.push(page.items.length); cursor = page.olderCursor;
    } while (cursor);
    assert.deepEqual(lengths, [50, 50, 5]); assert.equal(new Set(ids).size, 105);
  }
  const lounge = await db.channel.findUniqueOrThrow({ where: { slug: 'demo-lounge' } });
  await app.get(SendMessageService).send(accounts[0]!.id, { channelId: lounge.id, clientMessageId: randomUUID(), body: 'Added after seeding' });
  const withActivity = await fingerprint();
  await seedDemo(db, env); assert.deepEqual(await fingerprint(), withActivity, 'rerun preserves subsequent conversation and its sequence counter');
  await assert.rejects(seedDemo(db, { ...env, DEMO_BOB_PASSWORD: 'changed bob demo passphrase' }));
  assert.deepEqual(await fingerprint(), withActivity, 'a password mismatch cannot rewrite either identity');
  const planning = await db.channel.findUniqueOrThrow({ where: { slug: 'demo-planning' } });
  await db.message.update({ where: { channelId_sequence: { channelId: planning.id, sequence: 6n } }, data: { body: 'Preserve a changed existing message' } });
  const changedMessage = await fingerprint(); await assert.rejects(seedDemo(db, env));
  assert.deepEqual(await fingerprint(), changedMessage, 'a reserved client key never overwrites changed content');
  // A conflict after earlier inserts must roll the entire run back, including users/channels/counters.
  await db.message.deleteMany({ where: { authorId: { in: accounts.map(account => account.id) } } });
  await db.membership.deleteMany({ where: { userId: { in: accounts.map(account => account.id) } } });
  await db.channel.deleteMany({ where: { createdBy: accounts[0]!.id } });
  await db.session.deleteMany({ where: { userId: { in: accounts.map(account => account.id) } } });
  await db.user.deleteMany({ where: { id: { in: accounts.map(account => account.id) } } });
  await db.channel.create({ data: { name: 'Foreign planning', nameKey: 'demo planning', slug: 'demo-planning', createdBy: outsider.id } });
  const beforeCollision = await fingerprint();
  await assert.rejects(seedDemo(db, env));
  assert.deepEqual(await fingerprint(), beforeCollision, 'reserved channel collision must not appropriate or overwrite foreign data');
  await db.user.update({ where: { id: outsider.id }, data: { email: accounts[0]!.email } });
  const emailCollision = await fingerprint(); await assert.rejects(seedDemo(db, env));
  assert.deepEqual(await fingerprint(), emailCollision, 'a reserved email must not appropriate a user with another ID');
}
