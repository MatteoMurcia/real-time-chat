import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PublicMessage, SendMessageAck } from '@real-time-chat/contracts/messages';
import { RealtimeConnection } from '../../core/realtime-connection';
import { SessionStore } from '../../core/session.store';
import { ChatStore } from './chat.store';
import { HistoryClient } from './history-client';
import { SyncService } from './sync.service';
import { EMPTY, of, Subject, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import type { MessagePage, MessageSyncPage } from '@real-time-chat/contracts/messages';

const history = { list: vi.fn() };
const sync = { recover: vi.fn() };

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
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.clearAllMocks(); listeners.clear(); connection.status.set('connected');
  sync.recover.mockReturnValue(EMPTY);
  connection.subscription.mockImplementation(async (channelId, subscribed) => ({ ok: true, data: { channelId, subscribed } }));
  connection.send.mockImplementation(() => new Promise(() => undefined));
  history.list.mockReturnValue(of({ items: [], olderCursor: null, snapshotCursor: 'snapshot' }));
  TestBed.configureTestingModule({ providers: [ChatStore,
    { provide: RealtimeConnection, useValue: connection },
    { provide: HistoryClient, useValue: history },
    { provide: SyncService, useValue: sync },
    { provide: SessionStore, useValue: { session: () => ({ user: { id: 'user-1' } }) } },
  ] });
  store = TestBed.inject(ChatStore); store.open('channel-1'); await flush();
});
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('announces recovered messages once after all pages and stays silent on empty polling', () => {
  const pages = new Subject<MessageSyncPage>(); sync.recover.mockReturnValue(pages); store.recover();
  pages.next({ items: [canonical()], nextCursor: 'page-1', until: 'H', hasMore: true });
  expect(store.liveNotice()).toBe('');
  pages.next({ items: [canonical({ id: 'second', sequence: '2' })], nextCursor: 'H', until: 'H', hasMore: false });
  expect(store.liveNotice()).toBe(''); pages.complete();
  expect(store.liveNotice()).toBe('Conversation updated. 2 new messages loaded.');
  sync.recover.mockReturnValue(EMPTY); store.recover();
  expect(store.liveNotice()).toBe('Conversation updated. 2 new messages loaded.');
});

it('summarizes outgoing states without message bodies and announces zero after an ack alone', async () => {
  expect(store.outgoingNotice()).toBe('No messages awaiting confirmation.');
  store.send('Private draft');
  expect(store.outgoingNotice()).toBe('1 sending, 0 unconfirmed, 0 rejected.');
  const request = store.outgoing()[0]!.request;
  connection.send.mockResolvedValueOnce({ ok: true, data: canonical({ clientMessageId: request.clientMessageId, body: 'Private draft' }) });
  await vi.advanceTimersByTimeAsync(5000); await flush();
  expect(store.outgoingNotice()).toBe('No messages awaiting confirmation.');
  store.send('Another draft');
  expect(store.outgoingNotice()).toBe('1 sending, 0 unconfirmed, 0 rejected.');
});

it('seeds C from the snapshot, advances only after recovery pages and preserves it on errors and older history', async () => {
  expect(sync.recover).toHaveBeenCalledWith('channel-1', 'snapshot');
  const pending = new Subject<MessageSyncPage>(); sync.recover.mockReturnValue(pending);
  store.recover(); event(canonical({ id: 'live', sequence: '9' }));
  expect(store.syncCursor()).toBe('snapshot');
  pending.next({ items: [canonical()], nextCursor: 'page-1', until: 'H', hasMore: true });
  expect(store.messages().map(item => item.id)).toEqual(['message-1', 'live']);
  expect(store.syncCursor()).toBe('page-1');
  pending.error(new HttpErrorResponse({ status: 503 }));
  expect(store.syncError()).not.toBe(''); expect(store.syncLoading()).toBe(false);
  sync.recover.mockReturnValue(EMPTY); store.recover();
  expect(sync.recover).toHaveBeenLastCalledWith('channel-1', 'page-1');
  store.olderCursor.set('older');
  history.list.mockReturnValue(of({ items: [], olderCursor: null, snapshotCursor: 'snapshot' }));
  store.loadHistory(); expect(store.syncCursor()).toBe('page-1');
});

it('coalesces focus and interval triggers, pauses hidden/offline and cancels on destroy', async () => {
  sync.recover.mockClear(); const pending = new Subject<MessageSyncPage>(); sync.recover.mockReturnValue(pending);
  window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(45000);
  expect(sync.recover).toHaveBeenCalledOnce(); expect(pending.observed).toBe(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
  expect(pending.observed).toBe(false); await vi.advanceTimersByTimeAsync(30000);
  expect(sync.recover).toHaveBeenCalledOnce();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
  expect(sync.recover).toHaveBeenCalledTimes(2);
  connection.status.set('reconnecting'); await flush(); expect(pending.observed).toBe(false);
  await vi.advanceTimersByTimeAsync(30000); window.dispatchEvent(new Event('focus'));
  expect(sync.recover).toHaveBeenCalledTimes(2);
  connection.status.set('connected'); await flush(); expect(sync.recover).toHaveBeenCalledTimes(3);
  TestBed.resetTestingModule(); expect(pending.observed).toBe(false);
  window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(30000); expect(sync.recover).toHaveBeenCalledTimes(3);
});

it('recovers every 15 seconds when visible even without focus events', async () => {
  sync.recover.mockClear();
  await vi.advanceTimersByTimeAsync(14999); expect(sync.recover).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(sync.recover).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(15000); expect(sync.recover).toHaveBeenCalledTimes(2);
});

it('cancels obsolete recovery when switching channels and never merges its late page', async () => {
  const pending = new Subject<MessageSyncPage>(); sync.recover.mockReturnValue(pending); store.recover();
  sync.recover.mockReturnValue(EMPTY); store.open('channel-2'); await flush();
  expect(pending.observed).toBe(false);
  pending.next({ items: [canonical()], nextCursor: 'old', until: 'old', hasMore: false });
  expect(store.messages()).toEqual([]); expect(store.syncCursor()).toBe('snapshot');
  expect(sync.recover).toHaveBeenLastCalledWith('channel-2', 'snapshot');
});

it.each([401, 403, 404])('clears the view after recovery returns %s', status => {
  event(canonical()); sync.recover.mockReturnValue(throwError(() => new HttpErrorResponse({ status })));
  store.recover(); expect(store.messages()).toEqual([]); expect(store.ready()).toBe(false);
  expect(store.syncCursor()).toBeNull();
});

it('replaces an invalid cursor with a fresh snapshot without an immediate retry loop', () => {
  event(canonical()); sync.recover.mockClear();
  sync.recover.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 400 })));
  history.list.mockReturnValue(of({ items: [], olderCursor: null, snapshotCursor: 'fresh' }));
  store.recover(); expect(store.messages()).toEqual([]); expect(store.syncCursor()).toBe('fresh');
  expect(sync.recover).toHaveBeenCalledOnce(); expect(store.historyError()).toBe('');
});

it('retries a timeout only once automatically, then requires a current manual action', async () => {
  vi.useFakeTimers(); store.send('Hello');
  const request = store.outgoing()[0]!.request;
  await vi.advanceTimersByTimeAsync(5000);
  expect(connection.send).toHaveBeenCalledTimes(2);
  expect(connection.send.mock.calls[1]![0]).toBe(request);
  await vi.advanceTimersByTimeAsync(5000);
  const stale = store.outgoing()[0]!; expect(stale.state).toBe('unconfirmed');
  await vi.advanceTimersByTimeAsync(60000); expect(connection.send).toHaveBeenCalledTimes(2);
  store.retry(stale); store.retry(stale);
  expect(connection.send).toHaveBeenCalledTimes(3);
  event(canonical({ clientMessageId: request.clientMessageId })); store.retry(stale);
  expect(connection.send).toHaveBeenCalledTimes(3);
});

it('ignores an older attempt failure while its retry is pending, then confirms by event', async () => {
  vi.useFakeTimers();
  let resolve!: (ack: SendMessageAck) => void;
  connection.send.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  store.send('Hello'); const request = store.outgoing()[0]!.request;
  await vi.advanceTimersByTimeAsync(5000);
  resolve({ ok: false, error: { code: 'FORBIDDEN', message: 'old', requestId: '12345678-1234-4234-8234-123456789abc' } }); await flush();
  expect(store.ready()).toBe(true); expect(store.outgoing()[0]?.state).toBe('pending');
  event(canonical({ clientMessageId: request.clientMessageId }));
  await vi.advanceTimersByTimeAsync(5000);
  expect(store.messages()).toHaveLength(1); expect(store.outgoing()).toEqual([]);
});

it('accepts a late ack from the first attempt and ignores the retry failure after confirmation', async () => {
  vi.useFakeTimers();
  const replies: ((ack: SendMessageAck) => void)[] = [];
  connection.send.mockImplementation(() => new Promise(done => { replies.push(done); }));
  store.send('Hello'); const request = store.outgoing()[0]!.request;
  await vi.advanceTimersByTimeAsync(5000);
  const message = canonical({ clientMessageId: request.clientMessageId });
  replies[0]!({ ok: true, data: message }); await flush();
  replies[1]!({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'private', requestId: '12345678-1234-4234-8234-123456789abc' } }); await flush();
  event(message); await vi.advanceTimersByTimeAsync(30000);
  expect(store.messages()).toEqual([message]); expect(store.outgoing()).toEqual([]);
  expect(connection.send).toHaveBeenCalledTimes(2);
});

it('retains the original key after a lost ack and rate-limited retry, then confirms once by manual retry', async () => {
  vi.useFakeTimers();
  let originalAck!: (ack: SendMessageAck) => void;
  connection.send.mockImplementationOnce(() => new Promise(done => { originalAck = done; }))
    .mockResolvedValueOnce({ ok: false, error: { code: 'RATE_LIMITED', message: 'private', requestId: '12345678-1234-4234-8234-123456789abc' } });
  store.send('Hello'); const request = store.outgoing()[0]!.request;
  const saved = canonical({ clientMessageId: request.clientMessageId });
  await vi.advanceTimersByTimeAsync(5000);
  expect(store.outgoing()[0]?.state).toBe('unconfirmed');
  expect(store.outgoing()[0]?.request).toBe(request);
  await vi.advanceTimersByTimeAsync(60000); expect(connection.send).toHaveBeenCalledTimes(2);
  connection.send.mockResolvedValueOnce({ ok: true, data: saved });
  store.retry(store.outgoing()[0]!); await flush();
  expect(connection.send.mock.calls.map(call => call[0])).toEqual([request, request, request]);
  originalAck({ ok: true, data: saved }); await flush(); event(saved);
  expect(store.messages()).toEqual([saved]); expect(store.outgoing()).toEqual([]);
});

it.each(['VALIDATION_ERROR', 'CONFLICT', 'RATE_LIMITED', 'FORBIDDEN', 'UNAUTHENTICATED'] as const)('never retries %s automatically', async code => {
  vi.useFakeTimers();
  connection.send.mockResolvedValueOnce({ ok: false, error: { code, message: 'private', requestId: '12345678-1234-4234-8234-123456789abc' } });
  store.send('Hello'); await flush(); await vi.advanceTimersByTimeAsync(60000);
  expect(connection.send).toHaveBeenCalledOnce();
  if (code === 'FORBIDDEN' || code === 'UNAUTHENTICATED') {
    expect(store.ready()).toBe(false); expect(store.outgoing()).toEqual([]);
  } else if (code === 'RATE_LIMITED') {
    expect(store.outgoing()[0]?.state).toBe('unconfirmed');
  } else {
    const item = store.outgoing()[0]!; expect(item.state).toBe('rejected'); store.retry(item);
    expect(connection.send).toHaveBeenCalledOnce();
  }
});

it('cancels retry deadlines on view change/destroy and never retries offline', async () => {
  vi.useFakeTimers(); store.send('Hello');
  connection.status.set('reconnecting'); await flush();
  await vi.advanceTimersByTimeAsync(5000); expect(connection.send).toHaveBeenCalledOnce();
  connection.status.set('connected'); await flush();
  store.open('channel-2'); await flush(); store.send('New view');
  TestBed.resetTestingModule(); await vi.advanceTimersByTimeAsync(60000);
  expect(connection.send).toHaveBeenCalledTimes(2);
});

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

it('orders BIGINT sequences exactly and retains loaded messages beyond the old live-only cap', () => {
  event(null); event({}); event(canonical({ sequence: '1e9' })); event(canonical({ channelId: 'other' }));
  expect(store.messages()).toEqual([]);
  event(canonical({ id: 'high', sequence: '9007199254740993' }));
  event(canonical({ id: 'low', sequence: '9007199254740992' }));
  expect(store.messages().map(item => item.id)).toEqual(['low', 'high']);
  for (let i = 1; i <= 110; i++) event(canonical({ id: `m${i}`, sequence: String(i) }));
  expect(store.messages()).toHaveLength(112);
  expect(store.messages().at(-1)?.id).toBe('high');
});

it('subscribes before loading history and merges a delayed snapshot with live events once', async () => {
  const response = new Subject<MessagePage>(); history.list.mockReturnValue(response);
  store.open('channel-2'); await flush();
  expect(connection.subscription).toHaveBeenLastCalledWith('channel-2', true);
  expect(store.historyLoading()).toBe(true);
  const message = canonical({ channelId: 'channel-2' }); event(message);
  response.next({ items: [message], olderCursor: 'older', snapshotCursor: 'snapshot' }); response.complete();
  expect(store.messages()).toEqual([message]); expect(store.olderCursor()).toBe('older');
  expect(store.snapshotCursor()).toBe('snapshot'); expect(store.historyLoading()).toBe(false);
});

it('retries an older page without losing rows/cursors and cancels requests when switching or losing access', async () => {
  history.list.mockReturnValueOnce(of({ items: [canonical({ channelId: 'channel-2', sequence: '2' })], olderCursor: 'older', snapshotCursor: 'snapshot' }));
  store.open('channel-2'); await flush();
  history.list.mockReturnValueOnce(throwError(() => new Error('network'))); store.loadHistory();
  expect(store.messages()).toHaveLength(1); expect(store.olderCursor()).toBe('older'); expect(store.historyError()).not.toBe('');
  const pending = new Subject<MessagePage>(); history.list.mockReturnValueOnce(pending); store.loadHistory();
  store.loadHistory(); expect(history.list).toHaveBeenLastCalledWith('channel-2', 'older');
  expect(pending.observed).toBe(true); store.open('channel-3'); expect(pending.observed).toBe(false);
  history.list.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 403 }))); await flush();
  expect(store.messages()).toEqual([]); expect(store.snapshotCursor()).toBeNull(); expect(store.ready()).toBe(false);
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
