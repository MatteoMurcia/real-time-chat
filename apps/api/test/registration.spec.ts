import assert from 'node:assert/strict';
import { argon2 } from 'node:crypto';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { validateRegistration, hashPassword } from '../src/identity/registration.service.js';
import { CsrfService } from '../src/identity/csrf.service.js';

const origin = 'http://127.0.0.1:8080';
const valid = { email: ' User@Example.COM ', displayName: '  María  ', password: 'a long passphrase 🔐' };

test('registration normalizes identifiers but preserves the password exactly', () => {
  assert.deepEqual(validateRegistration(valid), { ...valid, email: 'user@example.com', displayName: 'María' });
  for (const body of [null, [], {}, { ...valid, role: 'admin' }, { ...valid, email: 'a..b@example.com' },
    { ...valid, email: 'a@-example.com' }, { ...valid, email: 'a\n@example.com' },
    { ...valid, displayName: '<script>' }, { ...valid, displayName: '\u0000name' },
    { ...valid, displayName: 'a'.repeat(81) }, { ...valid, password: 'short' },
    { ...valid, password: 'a'.repeat(129) }, { ...valid, password: 123 }]) {
    assert.throws(() => validateRegistration(body), /Bad Request/);
  }
});

test('Argon2id hashes use random salts and reproduce with the original password', async () => {
  const encoded = await hashPassword(valid.password);
  assert.notEqual(encoded, await hashPassword(valid.password));
  assert.match(encoded, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  const parts = encoded.split('$');
  const salt = Buffer.from(parts[4]!, 'base64');
  assert.equal(salt.length, 16);
  const digest = await promisify(argon2)('argon2id', {
    message: valid.password, nonce: salt, memory: 19456, passes: 2, parallelism: 1, tagLength: 32,
  });
  assert.equal(digest.toString('base64').replace(/=+$/, ''), parts[5]);
});

test('preauth CSRF binds signed tokens to a cookie, origin and expiry', () => {
  let now = 1_800_000_000_000;
  const csrf = new CsrfService(origin, () => now);
  const issued = csrf.issue({ origin });
  const cookie = issued.cookie.split(';')[0]!;
  const headers = { origin, cookie, 'x-csrf-token': issued.csrfToken };
  assert.doesNotThrow(() => csrf.verify(headers));
  assert.match(issued.cookie, /HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(issued.cookie, /; Secure/);
  for (const invalid of [ {}, { ...headers, origin: 'null' }, { ...headers, origin: `${origin}.evil.test` },
    { ...headers, origin: 'http://localhost:8080' }, { ...headers, cookie: '' },
    { ...headers, cookie: `${cookie}; ${cookie}` }, { ...headers, 'x-csrf-token': 'forged' },
    { ...headers, cookie: `${cookie}0` } ]) {
    assert.throws(() => csrf.verify(invalid), /Forbidden/);
  }
  assert.throws(() => new CsrfService(origin).verify(headers), /Forbidden/);
  const forged = `${issued.csrfToken.slice(0, -1)}${issued.csrfToken.endsWith('0') ? '1' : '0'}`;
  assert.throws(() => csrf.verify({ ...headers, cookie: `chat_preauth=${forged}`, 'x-csrf-token': forged }), /Forbidden/);
  const other = csrf.issue({ origin });
  assert.throws(() => csrf.verify({ ...headers, 'x-csrf-token': other.csrfToken }), /Forbidden/);
  now += 600_000;
  assert.throws(() => csrf.verify(headers), /Forbidden/);
  assert.throws(() => csrf.issue({}), /Forbidden/);
  assert.throws(() => csrf.issue({ origin: 'https://evil.test', referer: `${origin}/` }), /Forbidden/);
  assert.doesNotThrow(() => csrf.issue({ referer: `${origin}/register` }));
  assert.match(new CsrfService('https://chat.example').issue({ origin: 'https://chat.example' }).cookie,
    /^__Host-chat_preauth=.*; Secure$/);
});
