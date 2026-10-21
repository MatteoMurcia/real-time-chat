import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RealtimeConnection } from '../../core/realtime-connection';
import { SessionStore } from '../../core/session.store';
import { ActivityService } from '../../core/activity.service';
import { TypingStore } from './typing.store';

let receive: (value: unknown) => void;
const status = signal('connected'), visible = signal(true), typing = vi.fn(), stop = vi.fn();
const event = (connectionId = 'socket-one', id = 'other') => ({ channelId: 'channel', connectionId, user: { id, displayName: 'Alice' } });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10000); status.set('connected'); typing.mockClear(); stop.mockClear();
  visible.set(true);
  TestBed.configureTestingModule({ providers: [TypingStore,
    { provide: RealtimeConnection, useValue: { status, typing, listen: (_: string, listener: typeof receive) => { receive = listener; return stop; } } },
    { provide: SessionStore, useValue: { session: signal({ user: { id: 'self' } }) } },
    { provide: ActivityService, useValue: { visible } },
  ] });
});
afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });
function setup() { const store = TestBed.inject(TypingStore); TestBed.tick(); store.open('channel', true); return store; }

it('expires at five seconds without stop and renews only the received connection', () => {
  const store = setup(); receive(event()); expect(store.notice()).toBe('Alice is typing…');
  vi.advanceTimersByTime(4000); receive(event()); vi.advanceTimersByTime(4999);
  expect(store.notice()).toBe('Alice is typing…'); vi.advanceTimersByTime(1); expect(store.notice()).toBe('');
});
it('deduplicates a user across tabs and stopping one does not hide the other', () => {
  const store = setup(); receive(event()); receive(event('socket-two'));
  expect(store.notice()).toBe('Alice is typing…');
  receive({ channelId: 'channel', connectionId: 'socket-one', user: null });
  expect(store.notice()).toBe('Alice is typing…');
  receive({ channelId: 'channel', connectionId: 'socket-two', user: null }); expect(store.notice()).toBe('');
});
it('ignores self, malformed, wrong-channel and not-ready signals', () => {
  const store = setup();
  for (const value of [null, {}, event('self-tab', 'self'), { ...event(), channelId: 'another' }, { ...event(), user: { id: 'other', displayName: 42 } }]) receive(value);
  expect(store.notice()).toBe(''); store.open('channel', false); receive(event()); expect(store.notice()).toBe('');
});
it('throttles keystrokes at two seconds, expires local activity and sends no draft content', () => {
  const store = setup(); store.input('private draft'); store.input('more text');
  expect(typing.mock.calls).toEqual([[{ channelId: 'channel', typing: true }]]);
  vi.advanceTimersByTime(1999); store.input('more'); expect(typing).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1); store.input('more'); expect(typing).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(5000); expect(typing).toHaveBeenLastCalledWith({ channelId: 'channel', typing: false });
});
it('clears on channel change, failed subscription, hidden document, disconnection and destruction', () => {
  const store = setup(); store.input('draft'); receive(event()); store.open('another', true);
  expect(store.notice()).toBe(''); expect(typing).toHaveBeenLastCalledWith({ channelId: 'channel', typing: false });
  receive({ ...event(), channelId: 'another' }); store.open('another', false); expect(store.notice()).toBe('');
  store.open('channel', true); receive(event()); store.input('draft');
  visible.set(false); TestBed.tick();
  expect(store.notice()).toBe(''); const calls = typing.mock.calls.length; store.input('hidden'); receive(event()); expect(typing).toHaveBeenCalledTimes(calls);
  visible.set(true); TestBed.tick();
  receive(event()); status.set('reconnecting'); TestBed.tick(); expect(store.notice()).toBe('');
  store.input('offline'); expect(typing).toHaveBeenCalledTimes(calls);
  TestBed.resetTestingModule(); expect(stop).toHaveBeenCalledOnce();
});
it('stops on empty input and explicit send or blur without repeated stops', () => {
  const store = setup(); store.input('hello'); store.input(' '); store.stop();
  expect(typing.mock.calls).toEqual([[{ channelId: 'channel', typing: true }], [{ channelId: 'channel', typing: false }]]);
});

it('bounds retained connections and limits the announcement to three names and an additional count', () => {
  const store = setup();
  for (let index = 0; index < 101; index++) receive(event(`socket-${index}`, `user-${index}`));
  expect(store.notice()).toBe('Alice, Alice, Alice and 97 others are typing…');
  vi.advanceTimersByTime(5000); expect(store.notice()).toBe('');
});
