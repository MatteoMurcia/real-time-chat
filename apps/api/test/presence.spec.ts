import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePresence } from '../src/activity/presence.service.js';
import { RateLimitService } from '../src/security/rate-limit.service.js';
import { defaultTrafficLimits } from '../src/config.js';

const channelId = 'abcdef12-abcd-4123-8123-abcdef123456', userId = '12345678-abcd-4123-8123-abcdef123456';
test('presence accepts bounded unique user UUIDs and never accepts a client-selected viewer', () => {
  assert.deepEqual(validatePresence({ channelId: channelId.toUpperCase(), userIds: [userId.toUpperCase()] }), { channelId, userIds: [userId] });
  for (const input of [null, [], {}, { channelId, userIds: [] }, { channelId, userIds: [userId, userId.toUpperCase()] },
    { channelId, userIds: Array(101).fill(userId) }, { channelId, userIds: ['invalid'] }, { channelId, userIds: [4] },
    { channelId, userIds: [userId], viewerId: userId }]) assert.throws(() => validatePresence(input), { status: 400 });
});

test('presence reads have their own bounded per-user budget', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  const limits = new RateLimitService(defaultTrafficLimits);
  t.after(() => limits.onModuleDestroy());
  for (let index = 0; index < 20; index++) limits.consume('presence', 'user');
  assert.throws(() => limits.consume('presence', 'user'), { status: 429 });
  limits.consume('typing', 'user'); limits.consume('presence', 'other-user');
  t.mock.timers.tick(10000); limits.consume('presence', 'user');
});
