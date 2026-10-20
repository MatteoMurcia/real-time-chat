import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { Socket } from 'socket.io';
import { ConnectionsService } from '../src/realtime/connections.service.js';
import type { SessionService } from '../src/identity/session.service.js';

function socket(sessionId: string, expiresAt = Date.now() + 60000) {
  const events = new EventEmitter();
  return Object.assign(events, {
    data: { sessionId, userId: 'same-user', expiresAt }, request: { headers: { cookie: sessionId } }, connected: true,
    disconnect() { this.connected = false; events.emit('disconnect'); return this; },
  }) as unknown as Socket;
}

test('activity invalidations reach only the target user and never expired or revoked sessions', async t => {
  const revoked = new Subject<{ sessionId: string }>();
  const service = new ConnectionsService({ revoked, authenticate: async (id: string) => ({ id }) } as unknown as SessionService);
  t.after(() => service.onModuleDestroy());
  const first = socket('one'), second = socket('two'), stranger = socket('three');
  stranger.data.userId = 'different-user';
  await Promise.all([first, second, stranger].map(socket => service.add(socket)));
  const seen = [t.mock.fn(), t.mock.fn(), t.mock.fn()];
  [first, second, stranger].forEach((socket, i) => socket.on('activity:changed', seen[i]!));
  service.activityChanged(['same-user']);
  assert.deepEqual(seen.map(fn => fn.mock.callCount()), [1, 1, 0]);
  first.data.expiresAt = Date.now() - 1;
  revoked.next({ sessionId: 'two' });
  service.activityChanged(['same-user']);
  assert.deepEqual(seen.map(fn => fn.mock.callCount()), [1, 1, 0]);
});

test('revocation closes every socket of that session and preserves another session of the same user', async t => {
  const revoked = new Subject<{ sessionId: string }>();
  const service = new ConnectionsService({ revoked, authenticate: async (id: string) => ({ id }) } as unknown as SessionService);
  t.after(() => service.onModuleDestroy());
  const first = socket('one'), second = socket('one'), other = socket('two');
  const ended = t.mock.fn(); first.on('session:ended', ended); second.on('session:ended', ended); other.on('session:ended', ended);
  await Promise.all([first, second, other].map(socket => service.add(socket)));
  revoked.next({ sessionId: 'one' });
  assert.equal(first.connected, false); assert.equal(second.connected, false); assert.equal(other.connected, true);
  assert.equal(ended.mock.callCount(), 2);
  revoked.next({ sessionId: 'one' }); assert.equal(ended.mock.callCount(), 2);
});

test('expires idle sockets at the absolute deadline with one timer per session', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const timers = t.mock.method(globalThis, 'setTimeout');
  const revoked = new Subject<{ sessionId: string }>();
  const service = new ConnectionsService({ revoked, authenticate: async (id: string) => ({ id }) } as unknown as SessionService);
  t.after(() => service.onModuleDestroy());
  const first = socket('one', 2000), second = socket('one', 2000), other = socket('two', 3000);
  await Promise.all([first, second, other].map(socket => service.add(socket)));
  assert.equal(timers.mock.callCount(), 2);
  t.mock.timers.tick(999); assert.equal(first.connected, true);
  t.mock.timers.tick(1); assert.equal(first.connected, false); assert.equal(second.connected, false); assert.equal(other.connected, true);
  t.mock.timers.tick(1000); assert.equal(other.connected, false);
});

test('clears the last socket timer and removes the revocation listener on module destruction', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const revoked = new Subject<{ sessionId: string }>();
  const service = new ConnectionsService({ revoked, authenticate: async (id: string) => ({ id }) } as unknown as SessionService);
  const first = socket('one'), second = socket('one');
  await service.add(first); await service.add(second);
  first.disconnect(); assert.equal(clear.mock.callCount(), 0);
  second.disconnect(); assert.equal(clear.mock.callCount(), 1);
  const third = socket('two'); const ended = t.mock.fn(); third.on('session:ended', ended); await service.add(third);
  service.onModuleDestroy(); assert.equal(clear.mock.callCount(), 2); assert.equal(revoked.observed, false);
  t.mock.timers.tick(60000); revoked.next({ sessionId: 'two' }); assert.equal(ended.mock.callCount(), 0);
});

test('catches revocation both before registration and while the second authentication is pending', async t => {
  for (const alreadyRevoked of [true, false]) {
    const revoked = new Subject<{ sessionId: string }>();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const service = new ConnectionsService({ revoked, authenticate: async () => {
      await wait; if (alreadyRevoked) throw new UnauthorizedException(); return { id: 'one' };
    } } as unknown as SessionService);
    t.after(() => service.onModuleDestroy());
    if (alreadyRevoked) revoked.next({ sessionId: 'one' });
    const client = socket('one'), registered = service.add(client);
    if (!alreadyRevoked) revoked.next({ sessionId: 'one' });
    release(); await registered; assert.equal(client.connected, false);
  }
});

test('database failure closes the connection without claiming the session was revoked', async t => {
  const revoked = new Subject<{ sessionId: string }>();
  const service = new ConnectionsService({ revoked, authenticate: async () => { throw new Error('database unavailable'); } } as unknown as SessionService);
  t.after(() => service.onModuleDestroy());
  const client = socket('one'), ended = t.mock.fn(); client.on('session:ended', ended);
  await service.add(client); assert.equal(client.connected, false); assert.equal(ended.mock.callCount(), 0);
});
