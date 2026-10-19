import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoAccounts } from '../prisma/demo-seed.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('demo credentials have no defaults and reject invalid passwords without echoing secrets', () => {
  const valid = { DEMO_ALICE_PASSWORD: 'local alice demo passphrase', DEMO_BOB_PASSWORD: 'local bob demo passphrase' };
  for (const invalid of [{}, { ...valid, DEMO_ALICE_PASSWORD: '' }, { ...valid, DEMO_BOB_PASSWORD: 'short' },
    { ...valid, DEMO_BOB_PASSWORD: 'private-value-'.repeat(20) }]) {
    assert.throws(() => demoAccounts(invalid), error => error instanceof Error && error.message === 'Set valid DEMO_ALICE_PASSWORD and DEMO_BOB_PASSWORD (15–128 characters).');
  }
  const accounts = demoAccounts(valid);
  assert.deepEqual(accounts.map(account => account.email), ['alice@demo.example.test', 'bob@demo.example.test']);
  assert.deepEqual(accounts.map(account => account.password), [valid.DEMO_ALICE_PASSWORD, valid.DEMO_BOB_PASSWORD]);
  assert.equal(new Set(accounts.map(account => account.id)).size, 2);
});

test('seed CLI fails without exposing credentials or connection details', () => {
  const secret = 'private-seed-canary';
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../prisma/seed.js', import.meta.url))], {
    env: { ...process.env, DATABASE_URL: `postgresql://private:${secret}@127.0.0.1:1/private`, DEMO_ALICE_PASSWORD: secret, DEMO_BOB_PASSWORD: '' },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Demo seed failed/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes('postgresql:'), false);
});
