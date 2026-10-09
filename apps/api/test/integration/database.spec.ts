import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { isApiError } from '@real-time-chat/contracts';

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
