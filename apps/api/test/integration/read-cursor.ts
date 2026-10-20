import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { mock } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { DatabaseService } from '../../src/database/database.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { SendMessageService } from '../../src/messaging/send-message.service.js';
import { SessionService } from '../../src/identity/session.service.js';
import { hashPassword } from '../../src/identity/password.js';
import { ChannelAccessService } from '../../src/channels/channel-access.service.js';

export async function verifyReadCursors(app: INestApplication, db: DatabaseService): Promise<void> {
  const suffix = randomUUID(), password = 'isolated read cursor passphrase';
  const passwordHash = await hashPassword(password);
  const users = await Promise.all([0, 1, 2].map(i => db.user.create({ data: { email: `read-${i}-${suffix}@example.test`, displayName: `Reader ${i}`, passwordHash } })));
  const channels = app.get(ChannelsService), sessions = app.get(SessionService), origin = 'http://127.0.0.1:8080';
  const channel = (await channels.create(users[0]!.id, { name: 'Read cursor', slug: `read-${suffix}` })).channel;
  const endpoint = `${await app.getUrl()}/api/channels/${channel.id}/read-cursor`;
  const headers = await Promise.all([users[0]!, users[0]!, users[1]!, users[2]!].map(async user => {
    const cookie = (await sessions.login({ email: user.email, password })).cookie.split(';')[0]!;
    const response = await fetch(`${await app.getUrl()}/api/auth/session/csrf`, { headers: { origin, cookie } });
    return { origin, cookie, 'content-type': 'application/json', 'x-csrf-token': (await response.json()).csrfToken as string };
  }));
  const get = (index = 0, url = endpoint) => fetch(url, { headers: headers[index]! });
  const put = (lastReadSequence: string, index = 0) => fetch(endpoint, { method: 'PUT', headers: headers[index]!, body: JSON.stringify({ lastReadSequence }) });
  const cursor = async (response: Response, lastReadSequence: string) => {
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { channelId: channel.id, lastReadSequence });
  };
  await cursor(await get(), '0');
  assert.equal(await db.readCursor.count(), 0, 'GET must not create a cursor');
  await cursor(await put('0'), '0');
  assert.equal((await put('1')).status, 400, 'empty channels have no positive read boundary');
  await channels.setMembership(users[1]!.id, channel.id, true);
  for (let i = 0; i < 10; i++) await app.get(SendMessageService).send(users[0]!.id, { channelId: channel.id, clientMessageId: randomUUID(), body: `Saved ${i}` });
  const results = await Promise.all(['8', '2', '10', '1', '7', '4', '10', '3'].map((n, i) => put(n, i % 2)));
  for (const response of results) assert.equal(response.status, 200);
  await cursor(await get(1), '10');
  assert.equal(await db.readCursor.count({ where: { userId: users[0]!.id, channelId: channel.id } }), 1);
  await cursor(await put('2', 1), '10'); await cursor(await put('0'), '10'); await cursor(await put('10'), '10');
  await cursor(await get(2), '0'); await cursor(await put('3', 2), '3'); await cursor(await get(), '10');
  const unread = async (userId: string) => (await channels.list(userId, {})).channels.find(item => item.id === channel.id) as unknown as { unreadCount: number | null };
  assert.equal((await unread(users[0]!.id)).unreadCount, 0, 'own messages never count');
  assert.equal((await unread(users[1]!.id)).unreadCount, 7, 'count actual foreign messages after the saved cursor');
  assert.equal((await unread(users[2]!.id)).unreadCount, null, 'nonmembers receive no count');
  await channels.setMembership(users[1]!.id, channel.id, false);
  assert.equal((await unread(users[1]!.id)).unreadCount, null);
  await channels.setMembership(users[1]!.id, channel.id, true);
  assert.equal((await unread(users[1]!.id)).unreadCount, 7, 'rejoining restores the saved boundary');
  assert.equal((await fetch(endpoint)).status, 401);
  for (const method of ['GET', 'PUT']) {
    assert.equal((await fetch(endpoint, { method, headers: headers[3]!, ...(method === 'PUT' ? { body: JSON.stringify({ lastReadSequence: '1' }) } : {}) })).status, 403);
  }
  assert.equal((await fetch(endpoint, { method: 'PUT', headers: { cookie: headers[0]!.cookie, origin, 'content-type': 'application/json' }, body: '{"lastReadSequence":"1"}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'PUT', headers: { ...headers[0]!, origin: 'https://evil.test' }, body: '{"lastReadSequence":"1"}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'PUT', headers: { ...headers[0]!, 'content-type': 'text/plain' }, body: '{"lastReadSequence":"1"}' })).status, 400);
  for (const body of [{}, null, [], { lastReadSequence: 1 }, { lastReadSequence: '01' }, { lastReadSequence: '-1' },
    { lastReadSequence: '9223372036854775808' }, { lastReadSequence: '1', userId: users[1]!.id }]) {
    assert.equal((await fetch(endpoint, { method: 'PUT', headers: headers[0]!, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await get(0, `${endpoint}?userId=${users[1]!.id}`)).status, 400);
  assert.equal((await fetch(`${endpoint}?userId=${users[1]!.id}`, { method: 'PUT', headers: headers[0]!, body: '{"lastReadSequence":"1"}' })).status, 400);
  assert.equal((await put('11')).status, 400);
  // A sequence below the counter is still invalid if no committed message exists there.
  await db.channel.update({ where: { id: channel.id }, data: { lastSequence: 9007199254740993n } });
  const foreign = (await channels.create(users[1]!.id, { name: 'Other messages', slug: `foreign-${suffix}` })).channel;
  await db.message.create({ data: { channelId: foreign.id, authorId: users[1]!.id, clientMessageId: randomUUID(), sequence: 100n, body: 'Other channel sequence' } });
  assert.equal((await put('100')).status, 400);
  await db.message.create({ data: { channelId: channel.id, authorId: users[0]!.id, clientMessageId: randomUUID(), sequence: 9007199254740993n, body: 'Exact BIGINT boundary' } });
  await cursor(await put('9007199254740993'), '9007199254740993');
  assert.equal((await put('100')).status, 400, 'stale nonexistent boundaries are invalid too');
  await db.channel.update({ where: { id: channel.id }, data: { lastSequence: 9223372036854775807n } });
  await db.message.create({ data: { channelId: channel.id, authorId: users[0]!.id, clientMessageId: randomUUID(), sequence: 9223372036854775807n, body: 'PostgreSQL maximum' } });
  await cursor(await put('9223372036854775807'), '9223372036854775807');
  await channels.setMembership(users[0]!.id, channel.id, false);
  assert.equal((await get()).status, 403); assert.equal((await put('1')).status, 403);
  await channels.setMembership(users[0]!.id, channel.id, true);
  await cursor(await get(1), '9223372036854775807');
  assert.equal((await get(0, endpoint.replace(channel.id, randomUUID()))).status, 404);
  assert.equal((await get(0, endpoint.replace(channel.id, 'invalid'))).status, 400);

  const access = app.get(ChannelAccessService);
  const waitBlocked = async (pid?: number) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [row] = await db.$queryRaw<{ blocked: boolean }[]>`SELECT count(*) > 0 AS blocked FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND (${pid ?? null}::int IS NULL OR ${pid ?? null}::int = ANY(pg_blocking_pids(pid)))`;
      if (row?.blocked) return;
      await setTimeout(10);
    }
    assert.fail('the competing operation must wait on the real PostgreSQL channel lock');
  };
  // Both orders must respect the same authorization boundary as channel leave.
  for (const readFirst of [true, false]) {
    await channels.setMembership(users[0]!.id, channel.id, true);
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const lock = access.lockChannel.bind(access); let locks = 0;
    const pause = mock.method(access, 'lockChannel', async (...args: Parameters<typeof lock>) => {
      await lock(...args); if (++locks === 1) { entered(); await held; }
    });
    try {
      const first = readFirst ? put('1') : channels.setMembership(users[0]!.id, channel.id, false);
      await ready;
      const second = readFirst ? channels.setMembership(users[0]!.id, channel.id, false) : put('1');
      await waitBlocked(); release();
      const results = await Promise.all([first, second]);
      assert.equal((results[readFirst ? 0 : 1] as Response).status, readFirst ? 200 : 403);
      assert.equal((await get()).status, 403);
    } finally { release(); pause.mock.restore(); }
  }
  // A message is readable only after its transaction commits, never after rollback.
  for (const rollback of [false, true]) {
    const fresh = (await channels.create(users[0]!.id, { name: `Read commit ${rollback}`, slug: `commit-${Number(rollback)}-${suffix}` })).channel;
    let release!: () => void, inserted!: (pid: number) => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<number>(resolve => { inserted = resolve; });
    const writer = db.$transaction(async tx => {
      await access.lockChannel(tx, fresh.id);
      await tx.channel.update({ where: { id: fresh.id }, data: { lastSequence: 1n } });
      await tx.message.create({ data: { channelId: fresh.id, authorId: users[0]!.id, clientMessageId: randomUUID(), sequence: 1n, body: 'Held read boundary' } });
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      inserted(backend!.pid); await held;
      if (rollback) throw new Error('intentional read-boundary rollback');
    }).then(() => 'committed', error => { assert.equal(error.message, 'intentional read-boundary rollback'); return 'rolled back'; });
    const pid = await Promise.race([ready, writer.then(() => { throw new Error('writer ended before the barrier'); })]);
    const request = fetch(endpoint.replace(channel.id, fresh.id), { method: 'PUT', headers: headers[0]!, body: '{"lastReadSequence":"1"}' });
    try { await waitBlocked(pid); }
    finally { release(); await writer; }
    assert.equal((await request).status, rollback ? 400 : 200);
    const stored = await db.readCursor.findUnique({ where: { userId_channelId: { userId: users[0]!.id, channelId: fresh.id } } });
    assert.equal(stored?.lastReadSequence ?? 0n, rollback ? 0n : 1n);
  }
  await assert.rejects(db.readCursor.create({ data: { userId: users[2]!.id, channelId: channel.id, lastReadSequence: -1n } }));
  assert.equal(await db.readCursor.count({ where: { userId: users[2]!.id } }), 0);
}
