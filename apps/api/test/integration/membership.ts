import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { isApiError } from '@real-time-chat/contracts';
import type { ChannelPage } from '@real-time-chat/contracts/channels';
import { DatabaseService } from '../../src/database/database.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { ChannelAccessService } from '../../src/channels/channel-access.service.js';
import { SessionService } from '../../src/identity/session.service.js';
import { hashPassword } from '../../src/identity/password.js';

export async function verifyMembership(app: INestApplication, db: DatabaseService): Promise<void> {
  const suffix = randomUUID();
  const password = 'a membership integration passphrase';
  const passwordHash = await hashPassword(password);
  const users = await Promise.all([0, 1].map(index => db.user.create({ data: { email: `member-${index}-${suffix}@example.test`, displayName: 'Membership test', passwordHash } })));
  const access = app.get(ChannelAccessService);
  const sessions = app.get(SessionService);
  const base = `${await app.getUrl()}/api`;
  const origin = 'http://127.0.0.1:8080';
  try {
    const { channel } = await app.get(ChannelsService).create(users[0]!.id, { name: `Team ${suffix}`, slug: `team-${suffix}` });
    const headers = await Promise.all(users.map(async user => {
      const cookie = (await sessions.login({ email: user.email, password })).cookie.split(';')[0]!;
      const response = await fetch(`${base}/auth/session/csrf`, { headers: { cookie, origin } });
      const { csrfToken } = await response.json() as { csrfToken: string };
      return { cookie, origin, 'x-csrf-token': csrfToken };
    }));
    const mutate = (method: 'PUT' | 'DELETE', custom = headers[1]!, id = channel.id) => fetch(`${base}/channels/${id}/membership`, { method, headers: custom });
    const member = () => db.membership.findUnique({ where: { userId_channelId: { userId: users[1]!.id, channelId: channel.id } } });
    const visible = async () => {
      const page = await (await fetch(`${base}/channels`, { headers: headers[1]! })).json() as ChannelPage;
      return page.channels.find(item => item.id === channel.id)!;
    };
    await assert.rejects(access.requireMember(users[1]!.id, channel.id), ForbiddenException);
    for (const method of ['PUT', 'DELETE'] as const) {
      assert.equal((await mutate(method, { ...headers[1]!, cookie: '' })).status, 401);
      for (const invalid of [{ ...headers[1]!, origin: 'https://evil.test' }, { ...headers[1]!, 'x-csrf-token': '' }, { ...headers[1]!, 'x-csrf-token': headers[0]!['x-csrf-token'] }]) {
        assert.equal((await mutate(method, invalid)).status, 403);
      }
      assert.equal((await mutate(method, headers[1]!, 'invalid')).status, 400);
      assert.equal((await mutate(method, headers[1]!, randomUUID())).status, 404);
      assert.equal((await fetch(`${base}/channels/${channel.id}/membership?userId=${users[0]!.id}`, { method, headers: headers[1]! })).status, 400);
      assert.equal((await fetch(`${base}/channels/${channel.id}/membership`, { method, headers: { ...headers[1]!, 'content-type': 'application/json' }, body: JSON.stringify({ userId: users[0]!.id }) })).status, 400);
    }
    for (const response of await Promise.all([mutate('PUT'), mutate('PUT'), mutate('PUT')])) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { channelId: channel.id, isMember: true });
    }
    const joined = await member(); assert.ok(joined);
    assert.equal((await mutate('PUT')).status, 200);
    assert.equal((await member())!.joinedAt.getTime(), joined.joinedAt.getTime());
    await access.requireMember(users[1]!.id, channel.id);
    assert.equal((await visible()).isMember, true);
    for (const response of await Promise.all([mutate('DELETE'), mutate('DELETE')])) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { channelId: channel.id, isMember: false });
    }
    assert.equal(await member(), null);
    assert.equal((await visible()).isMember, false);
    await assert.rejects(access.requireMember(users[1]!.id, channel.id), ForbiddenException);
    await access.requireMember(users[0]!.id, channel.id);
    assert.equal((await mutate('DELETE', headers[0]!)).status, 200);
    await assert.rejects(access.requireMember(users[0]!.id, channel.id), ForbiddenException);
    assert.ok(await db.channel.findUnique({ where: { id: channel.id } }));
    await db.$executeRawUnsafe('ALTER TABLE "Membership" ADD CONSTRAINT "test_membership_failure" CHECK (false) NOT VALID');
    try {
      const response = await mutate('PUT');
      assert.equal(response.status, 500);
      assert.ok(isApiError(await response.json()));
      assert.equal(await member(), null);
    } finally { await db.$executeRawUnsafe('ALTER TABLE "Membership" DROP CONSTRAINT "test_membership_failure"'); }
    assert.equal((await mutate('PUT')).status, 200);
    const session = await sessions.authenticate(headers[1]!.cookie);
    await sessions.revoke(session.id);
    for (const method of ['PUT', 'DELETE'] as const) assert.equal((await mutate(method)).status, 401);
    assert.ok(await member());
  } finally {
    const ids = users.map(user => user.id);
    await db.membership.deleteMany({ where: { userId: { in: ids } } });
    await db.channel.deleteMany({ where: { createdBy: { in: ids } } });
    await db.session.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}
