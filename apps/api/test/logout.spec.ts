import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CsrfService } from '../src/identity/csrf.service.js';
import { SessionService } from '../src/identity/session.service.js';
import type { DatabaseService } from '../src/database/database.service.js';

test('authenticated CSRF rejects another session, preauth, forgery, wrong origin and expiry', () => {
  const origin = 'http://127.0.0.1:8080';
  let now = 1_800_000_000_000;
  const csrf = new CsrfService(origin, () => now);
  const { csrfToken } = csrf.issueSession({ origin }, 'session-a');
  const headers = { origin, 'x-csrf-token': csrfToken };
  assert.doesNotThrow(() => csrf.verifySession(headers, 'session-a'));
  assert.throws(() => csrf.verifySession(headers, 'session-b'), /Forbidden/);
  for (const invalid of [{}, { ...headers, origin: 'https://evil.test' },
    { ...headers, 'x-csrf-token': csrfToken.slice(0, -1) },
    { ...headers, 'x-csrf-token': csrf.issue({ origin }).csrfToken }]) {
    assert.throws(() => csrf.verifySession(invalid, 'session-a'), /Forbidden/);
  }
  assert.throws(() => csrf.issueSession({ origin: 'https://evil.test' }, 'session-a'), /Forbidden/);
  assert.throws(() => new CsrfService(origin).verifySession(headers, 'session-a'), /Forbidden/);
  now += 600_000;
  assert.throws(() => csrf.verifySession(headers, 'session-a'), /Forbidden/);
});

test('revocation emits only after deletion and clears the matching HTTP or HTTPS cookie', async () => {
  let count = 1;
  let fail = false;
  const db = { session: { deleteMany: async (input: unknown) => {
    assert.deepEqual(input, { where: { id: 'session-a' } });
    if (fail) throw new Error('database unavailable');
    return { count };
  } } } as unknown as DatabaseService;
  for (const origin of ['http://127.0.0.1:8080', 'https://chat.example']) {
    const service = new SessionService(db, origin, 60);
    const events: unknown[] = [];
    const subscription = service.revoked.subscribe(event => events.push(event));
    const cookie = await service.revoke('session-a');
    assert.equal(cookie, `${origin.startsWith('https') ? '__Host-chat_session' : 'chat_session'}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${origin.startsWith('https') ? '; Secure' : ''}`);
    assert.deepEqual(events, [{ sessionId: 'session-a' }]);
    count = 0;
    await service.revoke('session-a');
    fail = true;
    await assert.rejects(service.revoke('session-a'), /database unavailable/);
    assert.equal(events.length, 1);
    subscription.unsubscribe();
    count = 1;
    fail = false;
  }
});
