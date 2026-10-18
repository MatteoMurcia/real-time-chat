import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('test runner derives its URL from container settings and clears the development URL', () => {
  const result = spawnSync(process.execPath, ['--import', new URL('./test-env.mjs', import.meta.url).href, '-e', 'console.log(JSON.stringify({ test: process.env.TEST_DATABASE_URL, development: process.env.DATABASE_URL }))'], {
    env: { ...process.env, POSTGRES_USER: 'test@user', POSTGRES_PASSWORD: 'a:/?#@%b', POSTGRES_DB: 'isolated_test', DATABASE_URL: 'postgresql://wrong/development', TEST_DATABASE_URL: 'postgresql://wrong/other_test' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const body = JSON.parse(result.stdout.trim()), url = new URL(body.test);
  assert.equal(body.development, undefined);
  assert.equal(url.hostname, 'db');
  assert.equal(url.pathname, '/isolated_test');
  assert.equal(decodeURIComponent(url.username), 'test@user');
  assert.equal(decodeURIComponent(url.password), 'a:/?#@%b');
});

test('test runner refuses a non-test database without printing credentials', () => {
  const result = spawnSync(process.execPath, ['--import', new URL('./test-env.mjs', import.meta.url).href, '-e', ''], {
    env: { ...process.env, POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'private-fixture-password', POSTGRES_DB: 'development' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Integration requires a dedicated _test database/);
  assert.ok(!result.stderr.includes('private-fixture-password'));
});
