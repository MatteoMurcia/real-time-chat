import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';

test('GET /api/health/live returns minimal JSON over HTTP', async (t) => {
  const { app } = await createApp({ NODE_ENV: 'test', PORT: '3000' });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');

  const response = await fetch(`${await app.getUrl()}/api/health/live`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok' });

  const unprefixed = await fetch(`${await app.getUrl()}/health/live`);
  assert.equal(unprefixed.status, 404);
});

test('invalid configuration prevents application creation', async () => {
  await assert.rejects(createApp({ NODE_ENV: 'test' }), /PORT is required/);
});

test('the entry point exits with a readable error when PORT is missing', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
  delete env.PORT;
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../src/main.js', import.meta.url))],
    { env, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /API startup failed: PORT is required/);
});
