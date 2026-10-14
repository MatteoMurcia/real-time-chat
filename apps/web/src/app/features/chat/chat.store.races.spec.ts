import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EMPTY, Subject } from 'rxjs';
import type { ChannelSubscriptionAck } from '@real-time-chat/contracts/channels';
import type { MessagePage, MessageSyncPage, PublicMessage } from '@real-time-chat/contracts/messages';
import { RealtimeConnection } from '../../core/realtime-connection';
import { SessionStore } from '../../core/session.store';
import { ChatStore } from './chat.store';
import { HistoryClient } from './history-client';
import { SyncService } from './sync.service';

const history = { list: vi.fn() }, sync = { recover: vi.fn() };
const listeners = new Map<string, (value: unknown) => void>();
const connection = {
  status: signal('connected'),
  listen: (name: string, callback: (value: unknown) => void) => {
    listeners.set(name, callback); return () => listeners.delete(name);
  },
  subscription: vi.fn<(channelId: string, subscribed: boolean) => Promise<ChannelSubscriptionAck>>(),
};
const message = (channelId: string, sequence: number): PublicMessage => ({
  id: `${channelId}-${sequence}`, channelId, sequence: String(sequence), clientMessageId: `key-${sequence}`,
  body: `Message ${sequence}`, author: { id: 'user', displayName: 'Reader' }, createdAt: '2026-10-14T00:00:00Z',
});
const flush = async () => { TestBed.tick(); await Promise.resolve(); await Promise.resolve(); };
const event = (value: PublicMessage) => listeners.get('message:created')!(value);
let store: ChatStore;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); listeners.clear();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  connection.subscription.mockImplementation(async (channelId, subscribed) => ({ ok: true, data: { channelId, subscribed } }));
  history.list.mockReturnValue(EMPTY); sync.recover.mockReturnValue(EMPTY);
  TestBed.configureTestingModule({ providers: [ChatStore,
    { provide: RealtimeConnection, useValue: connection }, { provide: HistoryClient, useValue: history },
    { provide: SyncService, useValue: sync }, { provide: SessionStore, useValue: { session: () => ({ user: { id: 'user' } }) } },
  ] });
  store = TestBed.inject(ChatStore);
});
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('waits for subscription, merges events on both sides of H and advances C only through recovery', async () => {
  let acknowledge!: (ack: ChannelSubscriptionAck) => void;
  connection.subscription.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
  const snapshot = new Subject<MessagePage>(), recovery = new Subject<MessageSyncPage>();
  history.list.mockReturnValue(snapshot); sync.recover.mockReturnValue(recovery);
  store.open('A'); await flush();
  expect(history.list).not.toHaveBeenCalled(); expect(store.ready()).toBe(false);
  event(message('A', 1)); // Room delivery can precede the subscribe acknowledgement.
  acknowledge({ ok: true, data: { channelId: 'A', subscribed: true } }); await flush();
  expect(history.list).toHaveBeenCalledExactlyOnceWith('A', null);
  event(message('A', 3));
  snapshot.next({ items: [message('A', 1), message('A', 2)], snapshotCursor: 'H2', olderCursor: 'olderA' });
  snapshot.complete();
  expect(store.messages().map(row => row.sequence)).toEqual(['1', '2', '3']);
  expect(sync.recover).toHaveBeenCalledExactlyOnceWith('A', 'H2');
  event(message('A', 4)); expect(store.syncCursor()).toBe('H2');
  recovery.next({ items: [message('A', 3)], nextCursor: 'H3', until: 'H3', hasMore: false }); recovery.complete();
  expect(store.messages().map(row => row.sequence)).toEqual(['1', '2', '3', '4']);
  expect(store.snapshotCursor()).toBe('H2'); expect(store.olderCursor()).toBe('olderA'); expect(store.syncCursor()).toBe('H3');
});

it.each(['page', 'error'] as const)('cancels old A and B snapshots across A→B→A, including late %s responses', async kind => {
  const oldA = new Subject<MessagePage>(), oldB = new Subject<MessagePage>(), currentA = new Subject<MessagePage>();
  history.list.mockReturnValueOnce(oldA).mockReturnValueOnce(oldB).mockReturnValueOnce(currentA);
  store.open('A'); await flush(); store.open('B'); await flush(); store.open('A'); await flush();
  expect(oldA.observed).toBe(false); expect(oldB.observed).toBe(false); expect(currentA.observed).toBe(true);
  event(message('B', 99)); event(message('A', 3));
  currentA.next({ items: [message('A', 1), message('A', 2)], snapshotCursor: 'freshA', olderCursor: 'olderA' }); currentA.complete();
  for (const [channel, response] of [['A', oldA], ['B', oldB]] as const) {
    if (kind === 'error') response.error(new HttpErrorResponse({ status: 403 }));
    else response.next({ items: [message(channel, 99)], snapshotCursor: 'obsolete', olderCursor: 'obsoleteOlder' });
  }
  expect(store.messages().map(row => row.id)).toEqual(['A-1', 'A-2', 'A-3']);
  expect(store.snapshotCursor()).toBe('freshA'); expect(store.olderCursor()).toBe('olderA'); expect(store.syncCursor()).toBe('freshA');
  expect(store.ready()).toBe(true); expect(store.historyError()).toBe('');
  expect(sync.recover).toHaveBeenCalledExactlyOnceWith('A', 'freshA');
});

it('discards old subscription acknowledgements even when the same channel is selected again', async () => {
  const replies: ((ack: ChannelSubscriptionAck) => void)[] = [];
  connection.subscription.mockImplementation((channelId, subscribed) => subscribed
    ? new Promise(resolve => replies.push(resolve)) : Promise.resolve({ ok: true, data: { channelId, subscribed } }));
  store.open('A'); await flush(); store.open('B'); await flush(); store.open('A'); await flush();
  replies[0]!({ ok: true, data: { channelId: 'A', subscribed: true } });
  replies[1]!({ ok: false, error: { code: 'FORBIDDEN', message: 'Old view', requestId: '12345678-1234-4234-8234-123456789abc' } }); await flush();
  expect(history.list).not.toHaveBeenCalled(); expect(store.ready()).toBe(false);
  replies[2]!({ ok: true, data: { channelId: 'A', subscribed: true } }); await flush();
  expect(history.list).toHaveBeenCalledExactlyOnceWith('A', null); expect(store.ready()).toBe(true);
});

it('cancels a partially recovered old A interval before returning to a new A snapshot', async () => {
  const snapshot = new Subject<MessagePage>(), oldRecovery = new Subject<MessageSyncPage>();
  history.list.mockReturnValue(snapshot); sync.recover.mockReturnValueOnce(oldRecovery);
  store.open('A'); await flush(); snapshot.next({ items: [message('A', 1)], snapshotCursor: 'H1', olderCursor: null });
  oldRecovery.next({ items: [message('A', 2)], nextCursor: 'C2', until: 'H4', hasMore: true });
  expect(store.syncCursor()).toBe('C2');
  store.open('B'); await flush(); store.open('A'); await flush();
  expect(oldRecovery.observed).toBe(false); expect(store.syncCursor()).toBeNull();
  snapshot.next({ items: [message('A', 5)], snapshotCursor: 'H5', olderCursor: 'olderA' });
  oldRecovery.next({ items: [message('A', 4)], nextCursor: 'H4', until: 'H4', hasMore: false });
  expect(store.messages().map(row => row.id)).toEqual(['A-5']);
  expect(store.syncCursor()).toBe('H5'); expect(store.olderCursor()).toBe('olderA');
  expect(sync.recover).toHaveBeenLastCalledWith('A', 'H5');
});
