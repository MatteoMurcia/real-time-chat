import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseService } from '../src/database/database.service.js';

export function integrationDatabaseUrl(environment: NodeJS.ProcessEnv): URL {
  assert.ok(environment.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required; use a dedicated database ending in _test');
  let url: URL;
  try { url = new URL(environment.TEST_DATABASE_URL); } catch { throw new Error('Invalid integration database URL'); }
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'Integration requires PostgreSQL');
  assert.match(url.pathname, /^\/[a-zA-Z0-9_]+_test$/, 'Integration database name must end in _test');
  if (environment.DATABASE_URL) {
    let development: URL;
    try { development = new URL(environment.DATABASE_URL); } catch { throw new Error('Invalid development database URL'); }
    assert.notEqual(url.pathname, development.pathname, 'Test database must differ from development');
  }
  return url;
}

async function dropDatabase(admin: DatabaseService, name: string): Promise<void> {
  try { await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`); }
  catch { throw new Error('Could not remove isolated test database'); }
}

export async function withTestDatabase(run: (databaseUrl: string) => Promise<void>): Promise<void> {
  const base = integrationDatabaseUrl(process.env);
  const admin = new DatabaseService(base.href);
  // Only internally generated identifiers enter CREATE/DROP; never derive a target from caller input.
  const name = `suite_${randomUUID().replaceAll('-', '')}_test`;
  let created = false;
  try {
    try {
      await admin.onModuleInit();
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
    } catch { throw new Error('Could not create isolated test database; the test role needs CREATEDB'); }
    const isolated = new URL(base); isolated.pathname = `/${name}`;
    const migration = spawnSync(process.execPath, [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, DATABASE_URL: isolated.href }, encoding: 'utf8', timeout: 60000,
    });
    // Prisma output can contain connection information; retain only a safe phase on failure.
    assert.ok(!migration.error && migration.status === 0, 'Isolated database migration deployment failed');
    await run(isolated.href);
  } finally {
    try {
      if (created) await dropDatabase(admin, name);
    } finally { await admin.$disconnect(); }
  }
}
