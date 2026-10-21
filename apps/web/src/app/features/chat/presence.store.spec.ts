import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RealtimeConnection } from '../../core/realtime-connection';
import { ActivityService } from '../../core/activity.service';
import { PresenceStore } from './presence.store';

const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
const status = signal('connected'), visible = signal(true), revision = signal(0);
const presence = vi.fn(), stop = vi.fn();
let invalidate: () => void;
const response = (channelId = 'channel', users = [{ userId: first, online: true }]) => ({ ok: true, data: { channelId, users } });
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10000); presence.mockReset(); stop.mockReset();
  status.set('connected'); visible.set(true); revision.set(0);
  presence.mockResolvedValue(response());
  TestBed.configureTestingModule({ providers: [PresenceStore,
    { provide: RealtimeConnection, useValue: { status, presence, listen: (_: string, listener: typeof invalidate) => { invalidate = listener; return stop; } } },
    { provide: ActivityService, useValue: { visible, revision } },
  ] });
});
afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });
async function setup(ids = [first]) {
  const store = TestBed.inject(PresenceStore); TestBed.tick(); store.select('channel', true, ids);
  await vi.advanceTimersByTimeAsync(0); return store;
}

it('distinguishes unknown, online, offline and omitted without trusting a missing user', async () => {
  const pending = deferred(); presence.mockReturnValue(pending.promise);
  const store = await setup([first, second]);
  expect(store.label(first)).toBe('Presence unknown');
  pending.resolve(response('channel', [{ userId: first, online: false }])); await vi.advanceTimersByTimeAsync(0);
  expect(store.label(first)).toBe('Offline'); expect(store.label(second)).toBe('Presence unknown');
  presence.mockResolvedValue(response()); invalidate(); await vi.advanceTimersByTimeAsync(2000);
  expect(store.label(first)).toBe('Online');
});
it('retains confirmed labels during refresh and coalesces invalidations received while a query is pending', async () => {
  const store = await setup(); expect(store.label(first)).toBe('Online');
  const pending = deferred(); presence.mockReturnValueOnce(pending.promise);
  invalidate(); await vi.advanceTimersByTimeAsync(2000); expect(store.label(first)).toBe('Online');
  invalidate(); invalidate(); pending.resolve(response('channel', [{ userId: first, online: false }]));
  await vi.advanceTimersByTimeAsync(0); expect(store.label(first)).toBe('Online');
  await vi.advanceTimersByTimeAsync(2000); expect(presence).toHaveBeenCalledTimes(3); expect(store.label(first)).toBe('Online');
});
it('clears on disconnect and waits for a fresh acknowledged subscription after reconnect', async () => {
  const store = await setup(); status.set('reconnecting'); TestBed.tick();
  expect(store.label(first)).toBe('Presence unknown'); store.select('channel', false, [first]);
  status.set('connected'); TestBed.tick(); await vi.advanceTimersByTimeAsync(2000);
  expect(presence).toHaveBeenCalledTimes(1); expect(store.label(first)).toBe('Presence unknown');
  store.select('channel', true, [first]); await vi.advanceTimersByTimeAsync(0);
  expect(store.label(first)).toBe('Online');
});
it('keeps known authors stable when the loaded history introduces another author', async () => {
  const store = await setup();
  store.select('channel', true, [first, second]);
  expect(store.label(first)).toBe('Online'); expect(store.label(second)).toBe('Presence unknown');
  presence.mockResolvedValue(response('channel', [{ userId: first, online: true }, { userId: second, online: false }]));
  await vi.advanceTimersByTimeAsync(2000);
  expect(store.label(first)).toBe('Online'); expect(store.label(second)).toBe('Offline');
});
it('rejects late channel responses and clears users not retained by the new conversation', async () => {
  const pending = deferred(); presence.mockReturnValueOnce(pending.promise);
  const store = await setup(); store.select('other', true, [second]);
  presence.mockResolvedValue(response('other', [{ userId: second, online: false }]));
  pending.resolve(response()); await vi.advanceTimersByTimeAsync(0);
  expect(store.label(first)).toBe('Presence unknown'); expect(store.label(second)).toBe('Presence unknown');
  await vi.advanceTimersByTimeAsync(2000);
  expect(store.label(first)).toBe('Presence unknown'); expect(store.label(second)).toBe('Offline');
});
it('treats malformed, wrong-channel, duplicate and unrequested responses as unknown, then repairs through activity refresh', async () => {
  const store = await setup();
  for (const bad of [{ ok: false }, response('wrong'), response('channel', [{ userId: second, online: true }]),
    response('channel', [{ userId: first, online: true }, { userId: first, online: true }]),
    { ok: true, data: { channelId: 'channel', users: [{ userId: first, online: 'false' }] } }]) {
    presence.mockResolvedValueOnce(bad); invalidate(); await vi.advanceTimersByTimeAsync(2000);
    expect(store.label(first)).toBe('Presence unknown');
    presence.mockResolvedValue(response()); revision.update(value => value + 1); TestBed.tick();
    await vi.advanceTimersByTimeAsync(10000); expect(store.label(first)).toBe('Online');
  }
});
it('hides stale presence in hidden views and cleans up retries/listeners on destruction', async () => {
  const store = await setup(); visible.set(false); TestBed.tick(); expect(store.label(first)).toBe('Presence unknown');
  invalidate(); await vi.advanceTimersByTimeAsync(20000); expect(presence).toHaveBeenCalledTimes(1);
  visible.set(true); TestBed.tick(); await vi.advanceTimersByTimeAsync(0); expect(store.label(first)).toBe('Online');
  presence.mockRejectedValueOnce(new Error('timeout')); invalidate(); await vi.advanceTimersByTimeAsync(2000);
  expect(store.label(first)).toBe('Presence unknown'); const calls = presence.mock.calls.length;
  TestBed.resetTestingModule(); await vi.advanceTimersByTimeAsync(20000);
  expect(presence).toHaveBeenCalledTimes(calls); expect(stop).toHaveBeenCalledOnce();
});
it('bounds normalized author queries to 100, skips empty input and keeps repeated renders from polling', async () => {
  const ids = Array.from({ length: 105 }, (_, index) => `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`);
  presence.mockResolvedValue(response('channel', [])); const store = await setup([...ids, first, first.toUpperCase(), 'bad']);
  expect(presence.mock.calls[0]![0].userIds).toHaveLength(100);
  store.select('channel', true, [...ids, first, first.toUpperCase(), 'bad']); await vi.advanceTimersByTimeAsync(20000);
  expect(presence).toHaveBeenCalledTimes(1);
  store.select('channel', true, []); invalidate(); await vi.advanceTimersByTimeAsync(20000); expect(presence).toHaveBeenCalledTimes(1);
});
