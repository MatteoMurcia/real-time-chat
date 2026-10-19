import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoAccounts } from '../prisma/demo-seed.js';

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
