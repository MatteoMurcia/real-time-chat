import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../src/identity/password.js';
import { validateLogin } from '../src/identity/session.service.js';

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

test('login bounds untrusted input and normalizes only the email', () => {
  assert.deepEqual(validateLogin({ email: ' User@Example.test ', password: ' password ' }), { email: 'user@example.test', password: ' password ' });
  for (const body of [null, [], {}, { email: 'a', password: 1 }, { email: 'a', password: 'test', role: 'admin' }]) {
    assert.throws(() => validateLogin(body), /Bad Request/);
  }
  for (const body of [{ email: '', password: 'test' }, { email: 'a'.repeat(255), password: 'test' },
    { email: 'a', password: '' }, { email: 'a', password: 'x'.repeat(129) }, { email: 'a', password: '\ud800' }]) {
    assert.throws(() => validateLogin(body), /Unauthorized/);
  }
});
