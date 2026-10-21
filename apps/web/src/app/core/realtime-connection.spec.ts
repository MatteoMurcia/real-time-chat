import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionStore } from './session.store';
import { RealtimeConnection } from './realtime-connection';

const fake = vi.hoisted(() => ({
  listeners: new Map<string, (error?: unknown) => void>(), active: false, connected: false, id: 'socket-1',
  connect: vi.fn(), disconnect: vi.fn(), removeAllListeners: vi.fn(),
  on: vi.fn(), off: vi.fn(), timeout: vi.fn(), emitWithAck: vi.fn(),
  volatile: { emit: vi.fn() },
}));
vi.mock('socket.io-client', () => ({ io: () => fake }));
const session = signal<object | null>(null);
const end = vi.fn(() => session.set(null));

beforeEach(() => {
  vi.clearAllMocks(); fake.listeners.clear(); fake.active = false; session.set(null);
  fake.connected = false; fake.id = 'socket-1'; fake.timeout.mockReturnValue(fake);
  fake.on.mockImplementation((name: string, listener: (error?: unknown) => void) => fake.listeners.set(name, listener));
  fake.disconnect.mockImplementation(() => { fake.active = false; fake.connected = false; fake.listeners.get('disconnect')?.(); });
  TestBed.configureTestingModule({ providers: [RealtimeConnection, { provide: SessionStore, useValue: { session, end } }] });
});

it('never buffers presence while offline or accepts a reply from the previous socket', async () => {
  const connection = TestBed.inject(RealtimeConnection), input = { channelId: 'channel', userIds: ['user'] };
  await expect(connection.presence(input)).rejects.toThrow('Disconnected');
  expect(fake.emitWithAck).not.toHaveBeenCalled();
  fake.connected = true;
  let resolve!: (value: unknown) => void;
  fake.emitWithAck.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = connection.presence(input);
  expect(fake.timeout).toHaveBeenCalledWith(5000);
  fake.id = 'replacement-socket'; resolve({ ok: true });
  await expect(pending).rejects.toThrow('Disconnected');
  fake.emitWithAck.mockRejectedValueOnce(new Error('timeout'));
  await expect(connection.presence(input)).rejects.toThrow('timeout');
  expect(fake.disconnect).not.toHaveBeenCalled();
});

it('drops offline typing and uses a volatile emission without acknowledgement or replay', () => {
  const connection = TestBed.inject(RealtimeConnection);
  const input = { channelId: 'channel', typing: true };
  connection.typing(input); expect(fake.volatile.emit).not.toHaveBeenCalled();
  fake.connected = true; connection.typing(input);
  expect(fake.volatile.emit).toHaveBeenCalledExactlyOnceWith('typing:update', input);
  expect(fake.emitWithAck).not.toHaveBeenCalled();
});

it('serializes room changes across channels and removes exactly the registered listener', async () => {
  const connection = TestBed.inject(RealtimeConnection);
  fake.connected = true;
  let release!: (value: unknown) => void;
  fake.emitWithAck.mockImplementationOnce(() => new Promise(done => { release = done; })).mockResolvedValue({ ok: true });
  const first = connection.subscription('first', true);
  const second = connection.subscription('second', true);
  await Promise.resolve();
  expect(fake.emitWithAck).toHaveBeenCalledTimes(1);
  release({ ok: true }); await first; await second;
  expect(fake.emitWithAck.mock.calls.map(call => call[1])).toEqual([{ channelId: 'first' }, { channelId: 'second' }]);
  const listener = vi.fn(); const stop = connection.listen('message:created', listener); stop();
  expect(fake.off).toHaveBeenCalledWith('message:created', listener);
});

it('does not buffer offline sends and abandons uncertain room changes before the next selection', async () => {
  const connection = TestBed.inject(RealtimeConnection);
  await expect(connection.send({ channelId: 'c', clientMessageId: 'm', body: 'Hello' })).rejects.toThrow('Disconnected');
  expect(fake.emitWithAck).not.toHaveBeenCalled();
  fake.connected = true;
  fake.emitWithAck.mockRejectedValueOnce(new Error('timeout'));
  const first = connection.subscription('first', true);
  const second = connection.subscription('second', true);
  await expect(first).rejects.toThrow('timeout'); await expect(second).rejects.toThrow('Disconnected');
  expect(fake.disconnect).toHaveBeenCalledOnce(); expect(fake.emitWithAck).toHaveBeenCalledTimes(1);
});

it('keeps the send acknowledgement alive beyond the UI deadline with a bounded retention window', async () => {
  const connection = TestBed.inject(RealtimeConnection); fake.connected = true;
  let release!: (value: unknown) => void;
  fake.emitWithAck.mockImplementationOnce(() => new Promise(done => { release = done; }));
  const input = { channelId: 'c', clientMessageId: 'm', body: 'Hello' };
  const pending = connection.send(input);
  expect(fake.timeout).toHaveBeenCalledWith(30000);
  expect(fake.emitWithAck).toHaveBeenCalledWith('message:send', input);
  release({ ok: true }); await expect(pending).resolves.toEqual({ ok: true });
});

it('does not disconnect a replacement socket or replay room changes queued on the old one', async () => {
  const connection = TestBed.inject(RealtimeConnection);
  fake.connected = true;
  let reject!: (error: Error) => void;
  fake.emitWithAck.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
  const first = connection.subscription('first', true);
  const second = connection.subscription('second', true);
  await Promise.resolve();
  fake.id = 'socket-2'; reject(new Error('old socket disconnected'));
  await expect(first).rejects.toThrow('old socket disconnected');
  await expect(second).rejects.toThrow('Disconnected');
  expect(fake.disconnect).not.toHaveBeenCalled(); expect(fake.emitWithAck).toHaveBeenCalledTimes(1);
});
afterEach(() => TestBed.resetTestingModule());

it('keeps a session after the socket quota rejects connection and permits manual retry', () => {
  session.set({}); const connection = TestBed.inject(RealtimeConnection); TestBed.tick();
  fake.listeners.get('connect_error')?.({ data: { code: 'RATE_LIMITED', message: 'private', requestId: '12345678-1234-4234-8234-123456789abc' } });
  expect(connection.status()).toBe('rate-limited'); expect(end).not.toHaveBeenCalled();
  const previous = fake.connect.mock.calls.length; connection.connect();
  expect(fake.connect).toHaveBeenCalledTimes(previous + 1); expect(connection.status()).toBe('connecting');
});

it('clears identity on session end and keeps the terminal state through disconnect', () => {
  session.set({}); const connection = TestBed.inject(RealtimeConnection); TestBed.tick();
  fake.listeners.get('session:ended')?.(); fake.listeners.get('disconnect')?.(); TestBed.tick();
  expect(end).toHaveBeenCalledOnce(); expect(session()).toBeNull(); expect(connection.status()).toBe('unauthenticated');
  const attempts = fake.connect.mock.calls.length; connection.connect(); expect(fake.connect).toHaveBeenCalledTimes(attempts);
});

it('clears identity after a rejected reconnect but preserves it on transient transport failure', () => {
  session.set({}); const connection = TestBed.inject(RealtimeConnection);
  fake.active = true; fake.listeners.get('connect_error')?.(new Error('temporary'));
  expect(end).not.toHaveBeenCalled(); expect(session()).not.toBeNull(); expect(connection.status()).toBe('reconnecting');
  fake.listeners.get('connect_error')?.({ data: { code: 'UNAUTHENTICATED', message: 'Ended', requestId: '12345678-1234-4234-8234-123456789abc' } });
  expect(end).toHaveBeenCalledOnce(); expect(session()).toBeNull(); expect(connection.status()).toBe('unauthenticated');
});

it('connects only with a session and cleans up when the session or workspace ends', () => {
  const connection = TestBed.inject(RealtimeConnection);
  TestBed.tick();
  expect(fake.connect).not.toHaveBeenCalled();
  session.set({ user: { id: 'user' } }); TestBed.tick();
  expect(fake.connect).toHaveBeenCalledOnce();
  expect(connection.status()).toBe('connecting');
  fake.listeners.get('connect')?.();
  expect(connection.status()).toBe('connected');
  session.set(null); TestBed.tick();
  expect(fake.disconnect).toHaveBeenCalledOnce();
  expect(connection.status()).toBe('disconnected');
  TestBed.resetTestingModule();
  expect(fake.removeAllListeners).toHaveBeenCalledOnce();
});

it('distinguishes reconnecting transport errors from rejected authentication without exposing server text', () => {
  const connection = TestBed.inject(RealtimeConnection);
  fake.active = true;
  fake.listeners.get('disconnect')?.();
  expect(connection.status()).toBe('reconnecting');
  fake.listeners.get('connect_error')?.(new Error('private proxy detail'));
  expect(connection.status()).toBe('reconnecting');
  fake.active = false;
  fake.listeners.get('connect_error')?.({ data: { code: 'UNAUTHENTICATED', message: 'private', requestId: '12345678-1234-4234-8234-123456789abc' } });
  expect(connection.status()).toBe('unauthenticated');
  fake.listeners.get('connect_error')?.({ data: { code: 'UNAUTHENTICATED' } });
  expect(connection.status()).toBe('unavailable');
  expect(fake.connect).not.toHaveBeenCalled();
  session.set({}); connection.connect();
  expect(connection.status()).toBe('connecting');
  expect(fake.connect).toHaveBeenCalledOnce();
});
