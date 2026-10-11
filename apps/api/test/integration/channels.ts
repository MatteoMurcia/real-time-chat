import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { ChannelPage, CreateChannelResponse } from '@real-time-chat/contracts/channels';
import { isApiError } from '@real-time-chat/contracts';
import { DatabaseService } from '../../src/database/database.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { SessionService } from '../../src/identity/session.service.js';
import { hashPassword } from '../../src/identity/password.js';

export async function verifyChannels(app: INestApplication, db: DatabaseService): Promise<void> {
  const prefix = `c-${randomUUID()}`;
  const password = 'a channel integration passphrase';
  const passwordHash = await hashPassword(password);
  const users = await Promise.all([0, 1].map(index => db.user.create({ data: { email: `${prefix}-${index}@example.test`, displayName: 'Channel tester', passwordHash } })));
  const base = `${await app.getUrl()}/api`;
  const origin = 'http://127.0.0.1:8080';
  try {
    const cookies = await Promise.all(users.map(async user => (await app.get(SessionService).login({ email: user.email, password })).cookie.split(';')[0]!));
    const csrf = await fetch(`${base}/auth/session/csrf`, { headers: { origin, cookie: cookies[0]! } });
    const { csrfToken } = await csrf.json() as { csrfToken: string };
    const headers = { origin, cookie: cookies[0]!, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };
    const post = (body: unknown, custom = headers) => fetch(`${base}/channels`, { method: 'POST', headers: custom, body: JSON.stringify(body) });
    const input = { name: `Team ${prefix}`, slug: `${prefix}-01` };
    assert.equal((await fetch(`${base}/channels`)).status, 401);
    assert.equal((await post(input, { ...headers, cookie: '' })).status, 401);
    for (const invalid of [{ ...headers, origin: 'https://evil.test' }, { ...headers, 'x-csrf-token': '' }, { ...headers, cookie: cookies[1]! }]) {
      assert.equal((await post(input, invalid)).status, 403);
    }
    assert.equal((await post({ ...input, createdBy: users[1]!.id })).status, 400);
    assert.equal((await post({ ...input, slug: 'INVALID' })).status, 400);
    const results = await Promise.all([post(input), post(input)]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    const created = await results.find(result => result.status === 201)!.json() as CreateChannelResponse;
    assert.deepEqual(Object.keys(created.channel).sort(), ['createdAt', 'id', 'isMember', 'name', 'slug']);
    assert.equal(created.channel.isMember, true);
    assert.equal(await db.membership.count({ where: { channelId: created.channel.id, userId: users[0]!.id } }), 1);
    assert.equal((await db.channel.findUniqueOrThrow({ where: { id: created.channel.id } })).createdBy, users[0]!.id);
    assert.equal((await post({ ...input, name: `  TEAM   ${prefix.toUpperCase()}  `, slug: `${prefix}-02` })).status, 409);
    for (const suffix of ['02', '03']) assert.equal((await post({ name: `Team ${prefix} ${suffix}`, slug: `${prefix}-${suffix}` })).status, 201);
    const cursor = Buffer.from(`v1:${prefix}`).toString('base64url');
    const firstResponse = await fetch(`${base}/channels?limit=2&cursor=${cursor}`, { headers: { cookie: cookies[1]! } });
    assert.equal(firstResponse.headers.get('cache-control'), 'no-store');
    const first = await firstResponse.json() as ChannelPage;
    assert.deepEqual(first.channels.map(channel => channel.slug), [`${prefix}-01`, `${prefix}-02`]);
    assert.ok(first.channels.every(channel => !channel.isMember));
    assert.ok(first.nextCursor);
    const second = await (await fetch(`${base}/channels?limit=2&cursor=${first.nextCursor}`, { headers: { cookie: cookies[0]! } })).json() as ChannelPage;
    assert.equal(second.channels[0]?.slug, `${prefix}-03`);
    assert.equal(second.channels[0]?.isMember, true);
    for (const query of ['limit=101', 'limit=1&limit=2', 'cursor=garbage', 'userId=forged']) {
      const response = await fetch(`${base}/channels?${query}`, { headers: { cookie: cookies[0]! } });
      assert.equal(response.status, 400);
      assert.ok(isApiError(await response.json()));
    }
    await assert.rejects(db.membership.create({ data: { userId: users[0]!.id, channelId: created.channel.id } }), { code: 'P2002' });
    await assert.rejects(db.membership.create({ data: { userId: users[0]!.id, channelId: randomUUID() } }), { code: 'P2003' });
    // Force the second nested write to fail in this isolated, serial integration database.
    await db.$executeRawUnsafe('ALTER TABLE "Membership" ADD CONSTRAINT "test_membership_failure" CHECK (false) NOT VALID');
    try {
      await assert.rejects(app.get(ChannelsService).create(users[0]!.id, { name: `Rollback ${prefix}`, slug: `${prefix}-04` }));
      assert.equal(await db.channel.count({ where: { slug: `${prefix}-04` } }), 0);
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE "Membership" DROP CONSTRAINT "test_membership_failure"');
    }
  } finally {
    const ids = users.map(user => user.id);
    await db.membership.deleteMany({ where: { userId: { in: ids } } });
    await db.channel.deleteMany({ where: { createdBy: { in: ids } } });
    await db.session.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}
