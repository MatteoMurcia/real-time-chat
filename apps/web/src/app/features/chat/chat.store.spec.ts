import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PublicMessage, SendMessageAck } from '@real-time-chat/contracts/messages';
import { RealtimeConnection } from '../../core/realtime-connection';
import { SessionStore } from '../../core/session.store';
import { ChatStore } from './chat.store';

const listeners = new Map<string, (value: unknown) => void>();
const connection = {
  status: signal('connected'),
  listen: vi.fn((event: string, callback: (value: unknown) => void) => {
    listeners.set(event, callback); return () => listeners.delete(event);
  }),
  subscription: vi.fn(async (channelId: string, subscribed: boolean) => ({ ok: true, data: { channelId, subscribed } })),
  send: vi.fn<(value: unknown) => Promise<SendMessageAck>>(),
};
const canonical = (overrides: Partial<PublicMessage> = {}): PublicMessage => ({
  id: 'message-1', channelId: 'channel-1', clientMessageId: 'client-1', sequence: '1', body: 'Hello',
  author: { id: 'user-1', displayName: 'Alice' }, createdAt: '2026-10-12T10:00:00.000Z', ...overrides,
});
const flush = async () => { TestBed.tick(); await Promise.resolve(); await Promise.resolve(); };
const event = (value: unknown) => listeners.get('message:created')?.(value);
let store: ChatStore;

beforeEach(async () => {
  vi.clearAllMocks(); listeners.clear(); connection.status.set('connected');
  connection.subscription.mockImplementation(async (channelId, subscribed) => ({ ok: true, data: { channelId, subscribed } }));
  connection.send.mockImplementation(() => new Promise(() => undefined));
  TestBed.configureTestingModule({ providers: [ChatStore,
    { provide: RealtimeConnection, useValue: connection },
    { provide: SessionStore, useValue: { session: () => ({ user: { id: 'user-1' } }) } },
  ] });
  store = TestBed.inject(ChatStore); store.open('channel-1'); await flush();
});
afterEach(() => TestBed.resetTestingModule());

it('deduplicates event-before-ack and ack-before-event without removing another author’s pending key', async () => {
  let resolve!: (ack: SendMessageAck) => void;
  connection.send.mockImplementation(() => new Promise(done => { resolve = done; }));
  expect(store.send('Hello')).toBe(true);
  const request = store.outgoing()[0]!.request;
  const message = canonical({ clientMessageId: request.clientMessageId });
  event({ ...message, id: 'other', author: { id: 'user-2', displayName: 'Bob' } });
  expect(store.outgoing()).toHaveLength(1);
  event(message); resolve({ ok: true, data: message }); await flush(); event(message);
  expect(store.outgoing()).toHaveLength(0); expect(store.messages()).toHaveLength(2);
  connection.send.mockImplementation(async () => ({ ok: true, data: canonical({ id: 'second', sequence: '2', clientMessageId: store.outgoing()[0]!.request.clientMessageId }) }));
  store.send('Hello'); await flush(); event(store.messages()[2]);
  expect(store.messages()).toHaveLength(3); expect(store.outgoing()).toHaveLength(0);
});

it('orders BIGINT sequences exactly, ignores malformed/other-channel events and bounds live memory', () => {
  event(null); event({}); event(canonical({ sequence: '1e9' })); event(canonical({ channelId: 'other' }));
  expect(store.messages()).toEqual([]);
  event(canonical({ id: 'high', sequence: '9007199254740993' }));
  event(canonical({ id: 'low', sequence: '9007199254740992' }));
  expect(store.messages().map(item => item.id)).toEqual(['low', 'high']);
  for (let i = 1; i <= 110; i++) event(canonical({ id: `m${i}`, sequence: String(i) }));
  expect(store.messages()).toHaveLength(100);
  expect(store.messages().at(-1)?.id).toBe('high');
});

it('keeps the exact request for an uncertain retry, then confirms once', async () => {
  connection.send.mockRejectedValueOnce(new Error('timeout'));
  store.send('Hello'); await flush();
  const item = store.outgoing()[0]!;
  expect(item.state).toBe('unconfirmed');
  connection.send.mockResolvedValueOnce({ ok: true, data: canonical({ clientMessageId: item.request.clientMessageId }) });
  store.retry(item); await flush();
  expect(connection.send.mock.calls[1]![0]).toBe(item.request);
  expect(store.messages()).toHaveLength(1); expect(store.outgoing()).toEqual([]);
});

it('rejects invalid text locally, including lone surrogates, but accepts 2,000 emoji', () => {
  for (const body of [' ', 'x'.repeat(2001), '\0', '\uD800']) expect(store.send(body)).toBe(false);
  expect(connection.send).not.toHaveBeenCalled();
  expect(store.send('😀'.repeat(2000))).toBe(true);
});

it('pauses sending while disconnected and resubscribes without losing unconfirmed text', async () => {
  store.send('Hello'); connection.status.set('reconnecting'); await flush();
  expect(store.ready()).toBe(false); expect(store.send('Offline')).toBe(false);
  expect(store.outgoing()[0]?.state).toBe('unconfirmed');
  connection.status.set('connected'); await flush();
  expect(store.ready()).toBe(true); expect(connection.subscription).toHaveBeenCalledTimes(2);
});

it('ignores stale acknowledgements across channel changes and removes only its own listeners on destroy', async () => {
  let resolve!: (ack: SendMessageAck) => void;
  connection.send.mockImplementation(() => new Promise(done => { resolve = done; }));
  store.send('Hello'); const key = store.outgoing()[0]!.request.clientMessageId;
  store.open('channel-2'); await flush();
  resolve({ ok: true, data: canonical({ clientMessageId: key }) }); await flush();
  event(canonical()); expect(store.messages()).toEqual([]);
  expect(connection.subscription).toHaveBeenCalledWith('channel-1', false);
  TestBed.resetTestingModule(); expect(listeners.size).toBe(0);
  expect(connection.subscription).toHaveBeenCalledWith('channel-2', false);
});

it('clears content and blocks sends when membership is revoked', async () => {
  event(canonical()); store.send('Hello');
  listeners.get('channel:access-revoked')?.({ channelId: 'channel-1' }); await flush();
  expect(store.messages()).toEqual([]); expect(store.outgoing()).toEqual([]);
  expect(store.ready()).toBe(false); expect(store.send('Hello')).toBe(false);
  event(canonical()); expect(store.messages()).toEqual([]);
  expect(store.notice()).toContain('Access to this conversation ended');
});

it('ignores a successful subscription acknowledgement after revocation', async () => {
  let resolve!: (ack: { ok: boolean; data: { channelId: string; subscribed: boolean } }) => void;
  connection.subscription.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  connection.status.set('reconnecting'); await flush();
  connection.status.set('connected'); await flush();
  listeners.get('channel:access-revoked')?.({ channelId: 'channel-1' });
  resolve({ ok: true, data: { channelId: 'channel-1', subscribed: true } }); await flush();
  expect(store.ready()).toBe(false); expect(store.notice()).toContain('Access to this conversation ended');
});

it('distinguishes definite rejection from an uncertain server error', async () => {
  const error = { code: 'VALIDATION_ERROR' as const, message: 'private', requestId: '12345678-1234-4234-8234-123456789abc' };
  connection.send.mockResolvedValueOnce({ ok: false, error });
  store.send('Hello'); await flush(); expect(store.outgoing()[0]?.state).toBe('rejected');
  connection.send.mockResolvedValueOnce({ ok: false, error: { ...error, code: 'INTERNAL_ERROR' } });
  store.send('Hello'); await flush(); expect(store.outgoing()[1]?.state).toBe('unconfirmed');
  expect(store.notice()).not.toContain('private');
});
