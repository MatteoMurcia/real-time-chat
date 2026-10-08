import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('container URL escapes credentials and ignores host DATABASE_URL', () => {
  const result = spawnSync(process.execPath, ['--import', new URL('./database-env.mjs', import.meta.url).href, '-e', 'console.log(process.env.DATABASE_URL)'], {
    env: { ...process.env, POSTGRES_USER: 'test@user', POSTGRES_PASSWORD: 'a:/?#@%b', POSTGRES_DB: 'chat test', DATABASE_URL: 'postgresql://wrong/host' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const url = new URL(result.stdout.trim());
  assert.equal(url.hostname, 'db');
  assert.equal(decodeURIComponent(url.username), 'test@user');
  assert.equal(decodeURIComponent(url.password), 'a:/?#@%b');
  assert.equal(decodeURIComponent(url.pathname), '/chat test');
});

test('container startup rejects an empty password', () => {
  const result = spawnSync(process.execPath, ['--import', new URL('./database-env.mjs', import.meta.url).href, '-e', ''], {
    env: { ...process.env, POSTGRES_USER: 'test', POSTGRES_PASSWORD: '', POSTGRES_DB: 'test' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /POSTGRES_PASSWORD is required/);
});
