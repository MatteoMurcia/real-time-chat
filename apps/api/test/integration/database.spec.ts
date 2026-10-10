import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { isApiError } from '@real-time-chat/contracts';
import type { SessionResponse } from '@real-time-chat/contracts/auth';
import { hashPassword } from '../../src/identity/password.js';
import { SessionService } from '../../src/identity/session.service.js';

test('migrations, user/session constraints and application connection lifecycle', async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'TEST_DATABASE_URL is required; use a separate database ending in _test');
  const url = new URL(databaseUrl);
  assert.match(url.pathname, /_test$/, 'Integration database name must end in _test');
  if (process.env.DATABASE_URL) {
    const development = new URL(process.env.DATABASE_URL);
    assert.notEqual(url.pathname, development.pathname, 'Test database must differ from development');
  }

  const migration = spawnSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(migration.error, undefined);
  assert.equal(migration.status, 0, 'Migration deployment must succeed');

  const { app } = await createApp({ NODE_ENV: 'test', PORT: '3000', DATABASE_URL: databaseUrl });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const db = app.get(DatabaseService);
  const email = `${randomUUID()}@example.test`;
  const user = await db.user.create({ data: { email, displayName: 'Integration test', passwordHash: 'test-only-hash' } });
  t.after(async () => {
    // This separate client also makes cleanup safe after the lifecycle assertion closes the app.
    const cleanup = new DatabaseService(databaseUrl);
    try {
      await cleanup.session.deleteMany({ where: { userId: user.id } });
      await cleanup.user.delete({ where: { id: user.id } });
    } finally {
      await cleanup.$disconnect();
    }
  });
  const session = { userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 86400000) };

  await t.test('rejects duplicate email and token hashes', async () => {
    await assert.rejects(db.user.create({ data: { email, displayName: 'Duplicate', passwordHash: 'test-only-hash' } }), { code: 'P2002' });
    await db.session.create({ data: session });
    await assert.rejects(db.session.create({ data: session }), { code: 'P2002' });
  });

  await t.test('enforces user foreign keys and restricts deleting a user with sessions', async () => {
    await assert.rejects(db.session.create({ data: { ...session, tokenHash: randomUUID(), userId: randomUUID() } }), { code: 'P2003' });
    await assert.rejects(db.user.delete({ where: { id: user.id } }), { code: 'P2003' });
  });

  await t.test('rolls back failed transactions', async () => {
    const tokenHash = randomUUID();
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.session.create({ data: { ...session, tokenHash } });
      throw new Error('intentional rollback');
    }), /intentional rollback/);
    assert.equal(await db.session.count({ where: { tokenHash } }), 0);
  });

  await t.test('registers through HTTP with CSRF, safe validation and concurrent uniqueness', async () => {
    const endpoint = `${await app.getUrl()}/api/auth`;
    const origin = 'http://127.0.0.1:8080';
    const registrationEmail = `${randomUUID()}@example.test`;
    const input = { email: ` ${registrationEmail.toUpperCase()} `, displayName: '  María  ', password: 'a long passphrase 🔐' };
    try {
      assert.equal((await fetch(`${endpoint}/csrf`)).status, 403);
      assert.equal((await fetch(`${endpoint}/csrf`, { headers: { origin: 'https://evil.test' } })).status, 403);
      const bootstrap = await fetch(`${endpoint}/csrf`, { headers: { origin } });
      assert.equal(bootstrap.status, 200);
      assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
      const setCookie = bootstrap.headers.get('set-cookie')!;
      assert.match(setCookie, /HttpOnly; SameSite=Lax/);
      const { csrfToken } = await bootstrap.json() as { csrfToken: string };
      const headers = { origin, cookie: setCookie.split(';')[0]!, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };
      const post = (body: unknown, customHeaders = headers) => fetch(`${endpoint}/register`, {
        method: 'POST', headers: customHeaders, body: JSON.stringify(body),
      });
      for (const invalid of [{ ...headers, cookie: '' }, { ...headers, 'x-csrf-token': '' },
        { ...headers, origin: 'https://evil.test' }]) {
        const response = await post(input, invalid);
        assert.equal(response.status, 403);
        assert.ok(isApiError(await response.json()));
      }
      const invalid = await post({ ...input, email: 'invalid', password: 'secret' });
      assert.equal(invalid.status, 400);
      const error = await invalid.json();
      assert.ok(isApiError(error));
      assert.ok(error.fieldErrors?.email);
      assert.ok(error.fieldErrors?.password);
      assert.ok(!JSON.stringify(error).includes('secret'));
      assert.equal((await post({ ...input, role: 'admin' })).status, 400);
      assert.equal((await post(input, { ...headers, 'content-type': 'application/x-www-form-urlencoded' })).status, 400);
      const malformed = await fetch(`${endpoint}/register`, { method: 'POST', headers, body: '{broken' });
      assert.equal(malformed.status, 400);
      assert.ok(isApiError(await malformed.json()));
      const oversized = await post({ ...input, password: 'x'.repeat(9000) });
      assert.equal(oversized.status, 413);
      assert.ok(isApiError(await oversized.json()));
      assert.equal(await db.user.count({ where: { email: registrationEmail } }), 0);
      const responses = await Promise.all([post(input), post(input)]);
      assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
      const success = responses.find(response => response.status === 201)!;
      assert.equal(success.headers.get('cache-control'), 'no-store');
      assert.equal(success.headers.get('set-cookie'), null);
      const result = await success.json() as { user: Record<string, string> };
      assert.deepEqual(Object.keys(result), ['user']);
      assert.deepEqual(Object.keys(result.user).sort(), ['createdAt', 'displayName', 'email', 'id']);
      assert.equal(result.user.email, registrationEmail);
      assert.equal(result.user.displayName, 'María');
      const stored = await db.user.findUniqueOrThrow({ where: { email: registrationEmail } });
      assert.equal(result.user.id, stored.id);
      assert.equal(result.user.createdAt, stored.createdAt.toISOString());
      assert.match(stored.passwordHash, /^\$argon2id\$/);
      assert.equal(await db.session.count({ where: { userId: stored.id } }), 0);
      const conflict = responses.find(response => response.status === 409)!;
      const duplicate = await conflict.json();
      assert.ok(isApiError(duplicate));
      assert.equal(duplicate.code, 'CONFLICT');
    } finally {
      await db.user.deleteMany({ where: { email: registrationEmail } });
    }
  });

  await t.test('login stores only token hashes and restores valid sessions with absolute expiry', async () => {
    const origin = 'http://127.0.0.1:8080';
    const endpoint = `${await app.getUrl()}/api/auth`;
    const password = ' session test passphrase 🔐 ';
    const member = await db.user.create({ data: { email: `${randomUUID()}@example.test`, displayName: 'Session test', passwordHash: await hashPassword(password) } });
    try {
      const input = { email: ` ${member.email.toUpperCase()} `, password };
      const bootstrap = await fetch(`${endpoint}/csrf`, { headers: { origin } });
      const { csrfToken } = await bootstrap.json() as { csrfToken: string };
      const headers = { origin, 'content-type': 'application/json', cookie: bootstrap.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': csrfToken };
      const login = (body = input, customHeaders = headers) => fetch(`${endpoint}/login`, { method: 'POST', headers: customHeaders, body: JSON.stringify(body) });
      const me = (cookie = '') => fetch(`${endpoint}/me`, { headers: { cookie } });
      for (const invalid of [{ ...headers, cookie: '' }, { ...headers, 'x-csrf-token': 'forged' }, { ...headers, origin: 'https://evil.test' }]) {
        assert.equal((await login(input, invalid)).status, 403);
      }
      assert.equal((await login(input, { ...headers, 'content-type': 'text/plain' })).status, 400);
      const wrong = await login({ ...input, password: password.trim() });
      const unknown = await login({ ...input, email: `${randomUUID()}@example.test` });
      for (const failure of [wrong, unknown]) {
        assert.equal(failure.status, 401);
        assert.equal(failure.headers.get('set-cookie'), null);
      }
      const wrongBody = await wrong.json();
      const unknownBody = await unknown.json();
      assert.ok(isApiError(wrongBody) && isApiError(unknownBody));
      assert.deepEqual({ ...wrongBody, requestId: '' }, { ...unknownBody, requestId: '' });
      assert.equal(wrongBody.code, 'UNAUTHENTICATED');
      assert.equal(await db.session.count({ where: { userId: member.id } }), 0);

      const response = await login(input, { ...headers, cookie: `${headers.cookie}; chat_session=${'a'.repeat(64)}` });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const cookie = response.headers.get('set-cookie')!;
      assert.match(cookie, /^chat_session=[a-f0-9]{64}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax$/);
      const pair = cookie.split(';')[0]!;
      const token = pair.split('=')[1]!;
      assert.notEqual(token, 'a'.repeat(64));
      const result = await response.json() as SessionResponse;
      assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'user']);
      assert.deepEqual(Object.keys(result.user).sort(), ['createdAt', 'displayName', 'email', 'id']);
      assert.equal(result.user.id, member.id);
      assert.ok(!JSON.stringify(result).includes(token));
      assert.ok(!JSON.stringify(result).includes(password));
      const stored = await db.session.findUniqueOrThrow({ where: { tokenHash: createHash('sha256').update(token).digest('hex') } });
      assert.notEqual(stored.tokenHash, token);
      assert.equal(stored.expiresAt.toISOString(), result.expiresAt);
      assert.ok(Math.abs(stored.expiresAt.getTime() - stored.createdAt.getTime() - 86400000) < 2000);
      const restored = await me(pair);
      assert.equal(restored.status, 200);
      assert.equal(restored.headers.get('cache-control'), 'no-store');
      assert.equal(restored.headers.get('set-cookie'), null);
      assert.deepEqual(await restored.json(), result);
      for (const invalid of ['', 'chat_session=malformed', `chat_session=${'b'.repeat(64)}`, `${pair}; ${pair}`]) {
        const failure = await me(invalid);
        assert.equal(failure.status, 401);
        assert.ok(isApiError(await failure.json()));
      }
      const tokenInQuery = await fetch(`${endpoint}/me?token=${token}`);
      assert.equal(tokenInQuery.status, 401);
      const { app: freshApp } = await createApp({ NODE_ENV: 'test', PORT: '3000', DATABASE_URL: databaseUrl });
      try {
        await freshApp.listen(0, '127.0.0.1');
        const restoredAfterRestart = await fetch(`${await freshApp.getUrl()}/api/auth/me`, { headers: { cookie: pair } });
        assert.equal(restoredAfterRestart.status, 200);
        assert.deepEqual(await restoredAfterRestart.json(), result);
      } finally { await freshApp.close(); }

      const beforeExpiry = new SessionService(db, origin, 86400, () => stored.expiresAt.getTime() - 1);
      assert.deepEqual(await beforeExpiry.me(pair), result);
      const atExpiry = new SessionService(db, origin, 86400, () => stored.expiresAt.getTime());
      await assert.rejects(atExpiry.me(pair), /Unauthorized/);
      await db.session.update({ where: { id: stored.id }, data: { expiresAt: new Date(0) } });
      assert.equal((await me(pair)).status, 401);

      const second = await login();
      assert.equal(second.status, 200);
      const secondCookie = second.headers.get('set-cookie')!.split(';')[0]!;
      assert.notEqual(secondCookie, pair);
      assert.equal((await me(secondCookie)).status, 200);
      assert.equal((await me(pair)).status, 401);
      const httpsSessions = new SessionService(db, 'https://chat.example', 60);
      await httpsSessions.onModuleInit();
      const secure = await httpsSessions.login(input);
      assert.match(secure.cookie, /^__Host-chat_session=[a-f0-9]{64}; Path=\/; Max-Age=60; HttpOnly; SameSite=Lax; Secure$/);
      assert.equal((await httpsSessions.me(secure.cookie.split(';')[0])).user.id, member.id);
    } finally {
      await db.session.deleteMany({ where: { userId: member.id } });
      await db.user.delete({ where: { id: member.id } });
    }
  });

  await t.test('logout revokes only the current session and binds CSRF to that session', async () => {
    const origin = 'http://127.0.0.1:8080';
    const endpoint = `${await app.getUrl()}/api/auth`;
    const sessions = app.get(SessionService);
    const member = await db.user.create({ data: { email: `${randomUUID()}@example.test`, displayName: 'Logout test', passwordHash: await hashPassword('logout passphrase') } });
    const events: { sessionId: string }[] = [];
    const subscription = sessions.revoked.subscribe(event => events.push(event));
    try {
      const input = { email: member.email, password: 'logout passphrase' };
      const first = (await sessions.login(input)).cookie.split(';')[0]!;
      const second = (await sessions.login(input)).cookie.split(';')[0]!;
      const current = await sessions.authenticate(first);
      const bootstrap = (cookie: string, from = origin) => fetch(`${endpoint}/session/csrf`, { headers: { origin: from, cookie } });
      assert.equal((await bootstrap('')).status, 401);
      assert.equal((await bootstrap(first, 'https://evil.test')).status, 403);
      const csrfResponse = await bootstrap(first);
      assert.equal(csrfResponse.headers.get('cache-control'), 'no-store');
      assert.equal(csrfResponse.headers.get('set-cookie'), null);
      const { csrfToken } = await csrfResponse.json() as { csrfToken: string };
      assert.ok(!csrfToken.includes(current.id));
      const headers = { origin, cookie: first, 'x-csrf-token': csrfToken };
      const logout = (custom = headers) => fetch(`${endpoint}/logout`, { method: 'POST', headers: custom });
      for (const invalid of [{ ...headers, 'x-csrf-token': '' }, { ...headers, cookie: second }, { ...headers, origin: 'https://evil.test' }]) {
        const failure = await logout(invalid);
        assert.equal(failure.status, 403);
        assert.equal(failure.headers.get('set-cookie'), null);
        assert.ok(isApiError(await failure.json()));
      }
      assert.equal(await db.session.count({ where: { userId: member.id } }), 2);
      assert.equal(events.length, 0);
      const response = await logout();
      assert.equal(response.status, 204);
      assert.equal(await response.text(), '');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('set-cookie'), 'chat_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      assert.deepEqual(events, [{ sessionId: current.id }]);
      assert.equal(await db.session.count({ where: { id: current.id } }), 0);
      assert.equal((await fetch(`${endpoint}/me`, { headers: { cookie: first } })).status, 401);
      assert.equal((await fetch(`${endpoint}/me`, { headers: { cookie: second } })).status, 200);
      assert.equal((await logout()).status, 401);
      assert.equal((await bootstrap(first)).status, 401);
      assert.equal(events.length, 1);
    } finally {
      subscription.unsubscribe();
      await db.session.deleteMany({ where: { userId: member.id } });
      await db.user.delete({ where: { id: member.id } });
    }
  });

  await t.test('serves liveness with real application wiring and closes database connections', async () => {
    assert.equal((await fetch(`${await app.getUrl()}/api/health/live`)).status, 200);
    const connections = await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    assert.ok(connections[0]);
    await app.close();
    const observer = new DatabaseService(databaseUrl);
    try {
      const active = await observer.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_stat_activity WHERE pid = ${connections[0].pid}`;
      assert.equal(active[0]?.count, 0n);
    } finally {
      await observer.$disconnect();
    }
  });
});

test('failed connection does not expose the connection URL', async () => {
  const db = new DatabaseService('postgresql://private:private-password@127.0.0.1:1/unreachable');
  try {
    await assert.rejects(db.onModuleInit(), { message: 'Database connection failed' });
  } finally {
    await db.$disconnect();
  }
});
