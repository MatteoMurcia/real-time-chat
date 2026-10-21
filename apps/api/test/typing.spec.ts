import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTyping } from '../src/activity/validate-typing.js';
import { RateLimitService } from '../src/security/rate-limit.service.js';
import { defaultTrafficLimits } from '../src/config.js';

const channelId = 'abcdef12-abcd-4123-8123-abcdef123456';
test('typing accepts only a channel UUID and boolean, never client-supplied identity or text', () => {
  assert.deepEqual(validateTyping({ channelId: channelId.toUpperCase(), typing: true }), { channelId, typing: true });
  assert.deepEqual(validateTyping({ channelId, typing: false }), { channelId, typing: false });
  for (const input of [null, [], {}, { channelId, typing: 'true' }, { channelId: 'bad', typing: true },
    { channelId, typing: true, userId: 'forged' }, { channelId, typing: true, body: 'private draft' }]) {
    assert.throws(() => validateTyping(input), { status: 400 });
  }
});

test('typing has a separate sliding quota shared by user, including stop and invalid attempts', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  const limits = new RateLimitService(defaultTrafficLimits);
  t.after(() => limits.onModuleDestroy());
  for (let i = 0; i < 10; i++) limits.consume('typing', 'user');
  assert.throws(() => limits.consume('typing', 'user'), { status: 429 });
  limits.consume('send', 'user'); limits.consume('typing', 'another-user');
  t.mock.timers.tick(10000); limits.consume('typing', 'user');
});
