import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionStore } from './session.store';
import { RealtimeConnection } from './realtime-connection';

const fake = vi.hoisted(() => ({
  listeners: new Map<string, (error?: unknown) => void>(), active: false, connected: false, id: 'socket-1',
  connect: vi.fn(), disconnect: vi.fn(), removeAllListeners: vi.fn(),
  on: vi.fn(), off: vi.fn(), timeout: vi.fn(), emitWithAck: vi.fn(),
}));
vi.mock('socket.io-client', () => ({ io: () => fake }));
const session = signal<object | null>(null);

beforeEach(() => {
  vi.clearAllMocks(); fake.listeners.clear(); fake.active = false; session.set(null);
  fake.connected = false; fake.id = 'socket-1'; fake.timeout.mockReturnValue(fake);
  fake.on.mockImplementation((name: string, listener: (error?: unknown) => void) => fake.listeners.set(name, listener));
  fake.disconnect.mockImplementation(() => { fake.active = false; fake.connected = false; fake.listeners.get('disconnect')?.(); });
  TestBed.configureTestingModule({ providers: [RealtimeConnection, { provide: SessionStore, useValue: { session } }] });
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
afterEach(() => TestBed.resetTestingModule());

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
