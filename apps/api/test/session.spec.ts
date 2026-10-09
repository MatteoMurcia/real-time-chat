import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../src/identity/password.js';

test('password verification preserves the exact input and rejects unsupported hashes', async () => {
  const password = '  a long passphrase 🔐  ';
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password.trim(), hash), false);
  assert.equal(await verifyPassword('wrong password', hash), false);
  for (const invalid of ['plaintext', hash.replace('m=19456', 'm=999999999'), hash.slice(0, -1)]) {
    await assert.rejects(verifyPassword(password, invalid), /Unsupported password hash/);
  }
});
