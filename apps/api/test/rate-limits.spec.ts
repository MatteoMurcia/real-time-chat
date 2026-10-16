import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Socket } from 'socket.io';
import { RateLimitService } from '../src/security/rate-limit.service.js';
import { defaultTrafficLimits } from '../src/config.js';

test('uses sliding windows per action and identity including the exact expiry boundary', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  const limits = new RateLimitService(defaultTrafficLimits);
  t.after(() => limits.onModuleDestroy());
  for (let i = 0; i < 29; i++) limits.consume('send', 'user');
  t.mock.timers.tick(5000); limits.consume('send', 'user');
  assert.throws(() => limits.consume('send', 'user'), { status: 429 });
  limits.consume('send', 'other'); limits.consume('createChannel', 'user');
  t.mock.timers.tick(4999);
  assert.throws(() => limits.consume('send', 'user'), { status: 429 });
  t.mock.timers.tick(1);
  for (let i = 0; i < 29; i++) limits.consume('send', 'user');
  assert.throws(() => limits.consume('send', 'user'), { status: 429 });
  t.mock.timers.tick(5000); limits.consume('send', 'user');
});

test('bounds active buckets without evicting limits, and cleans idle identities', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  const limits = new RateLimitService(defaultTrafficLimits);
  t.after(() => limits.onModuleDestroy());
  for (let i = 0; i < 10000; i++) limits.consume('send', `user-${i}`);
  assert.throws(() => limits.consume('send', 'overflow'), { status: 429 });
  for (let i = 1; i < 30; i++) limits.consume('send', 'user-0');
  assert.throws(() => limits.consume('send', 'user-0'), { status: 429 });
  t.mock.timers.tick(60000); limits.consume('send', 'overflow');
});

test('enforces the default login, registration and channel windows and clears cleanup on destruction', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  const clear = t.mock.method(globalThis, 'clearInterval');
  for (const [action, count, duration] of [['login', 10, 60000], ['register', 5, 3600000], ['createChannel', 10, 3600000]] as const) {
    const limits = new RateLimitService(defaultTrafficLimits);
    for (let i = 0; i < count; i++) limits.consume(action, 'identity');
    t.mock.timers.tick(duration - 1); assert.throws(() => limits.consume(action, 'identity'), { status: 429 });
    t.mock.timers.tick(1); limits.consume(action, 'identity'); limits.onModuleDestroy();
  }
  assert.equal(clear.mock.callCount(), 3);
});

function socket(sessionId: string) {
  return Object.assign(new EventEmitter(), { data: { sessionId }, conn: Object.assign(new EventEmitter(), { readyState: 'open' }) }) as unknown as Socket;
}

test('reserves concurrent session slots synchronously and releases once on disconnect or aborted handshake', t => {
  const limits = new RateLimitService(defaultTrafficLimits);
  t.after(() => limits.onModuleDestroy());
  const sockets = Array.from({ length: 6 }, () => socket('session'));
  for (const client of sockets.slice(0, 5)) limits.reserveConnection(client);
  assert.throws(() => limits.reserveConnection(sockets[5]!), { status: 429 });
  limits.reserveConnection(socket('other-session'));
  sockets[0]!.conn.emit('close'); sockets[0]!.emit('disconnect');
  limits.reserveConnection(sockets[5]!);
  assert.throws(() => limits.reserveConnection(socket('session')), { status: 429 });
  sockets[1]!.emit('disconnect'); sockets[1]!.conn.emit('close');
  limits.reserveConnection(socket('session'));
  const aborted = socket('already-closed'); aborted.conn.readyState = 'closed';
  assert.throws(() => limits.reserveConnection(aborted), { status: 401 });
});
