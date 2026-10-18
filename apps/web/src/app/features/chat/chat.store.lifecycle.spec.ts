import { Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { EMPTY, Subject } from 'rxjs';
import type { MessagePage } from '@real-time-chat/contracts/messages';
import { RealtimeConnection } from '../../core/realtime-connection';
import { SessionStore } from '../../core/session.store';
import { ChatStore } from './chat.store';
import { HistoryClient } from './history-client';
import { SyncService } from './sync.service';

@Component({ template: '', providers: [ChatStore] })
class StoreView { readonly store = inject(ChatStore); }

afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('releases socket handlers, window/document listeners, timers and pending history on twenty remounts', async () => {
  vi.useFakeTimers();
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  const addedToWindow = vi.spyOn(window, 'addEventListener'), removedFromWindow = vi.spyOn(window, 'removeEventListener');
  const addedToDocument = vi.spyOn(document, 'addEventListener'), removedFromDocument = vi.spyOn(document, 'removeEventListener');
  const connection = {
    status: signal('connected'),
    listen: (event: string, listener: (value: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(listener);
      return () => handlers.get(event)!.delete(listener);
    },
    subscription: vi.fn(async (channelId: string, subscribed: boolean) => ({ ok: true, data: { channelId, subscribed } })),
  };
  const history = { list: vi.fn() }, sync = { recover: vi.fn(() => EMPTY) };
  TestBed.configureTestingModule({ imports: [StoreView], providers: [
    { provide: RealtimeConnection, useValue: connection }, { provide: HistoryClient, useValue: history },
    { provide: SyncService, useValue: sync }, { provide: SessionStore, useValue: { session: () => ({ user: { id: 'reader' } }) } },
  ] });
  for (let cycle = 0; cycle < 20; cycle++) {
    const page = new Subject<MessagePage>(); history.list.mockReturnValue(page);
    const fixture = TestBed.createComponent(StoreView), store = fixture.componentInstance.store;
    store.open(`channel-${cycle}`); fixture.detectChanges(); TestBed.tick();
    await Promise.resolve(); await Promise.resolve();
    expect(page.observed).toBe(true);
    expect([...handlers.values()].map(listeners => listeners.size)).toEqual([1, 1]);
    expect(vi.getTimerCount()).toBe(1);
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(page.observed).toBe(false);
    expect([...handlers.values()].map(listeners => listeners.size)).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
    expect(connection.subscription).toHaveBeenLastCalledWith(`channel-${cycle}`, false);
    const focusListener = addedToWindow.mock.calls.filter(([type]) => type === 'focus').at(-1)![1];
    const visibilityListener = addedToDocument.mock.calls.filter(([type]) => type === 'visibilitychange').at(-1)![1];
    expect(removedFromWindow).toHaveBeenCalledWith('focus', focusListener);
    expect(removedFromDocument).toHaveBeenCalledWith('visibilitychange', visibilityListener);
  }
  const calls = history.list.mock.calls.length;
  window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(30000);
  expect(history.list).toHaveBeenCalledTimes(calls); expect(sync.recover).not.toHaveBeenCalled();
});
