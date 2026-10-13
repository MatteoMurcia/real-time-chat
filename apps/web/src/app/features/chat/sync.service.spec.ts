import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SyncService } from './sync.service';

let service: SyncService, http: HttpTestingController;
const item = { id: 'message', channelId: 'channel', clientMessageId: 'key', sequence: '9007199254740993', body: 'Hello',
  author: { id: 'user', displayName: 'Alice' }, createdAt: '2026-10-13T00:00:00Z' };
beforeEach(() => {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  service = TestBed.inject(SyncService); http = TestBed.inject(HttpTestingController);
});
afterEach(() => { http.verify(); TestBed.resetTestingModule(); vi.useRealTimers(); });

it('recovers all pages with the same H and cancels the active HTTP request', () => {
  const pages: unknown[] = [];
  const subscription = service.recover('channel', 'C').subscribe(page => pages.push(page));
  const first = { items: [item], nextCursor: 'next', until: 'H', hasMore: true };
  http.expectOne('/api/channels/channel/messages/sync?after=C').flush(first);
  expect(pages).toEqual([first]);
  const request = http.expectOne('/api/channels/channel/messages/sync?after=next&until=H');
  subscription.unsubscribe(); expect(request.cancelled).toBe(true);
});

it('finishes on an empty final interval', () => {
  let completed = false;
  service.recover('channel', 'C').subscribe({ complete: () => { completed = true; } });
  http.expectOne('/api/channels/channel/messages/sync?after=C').flush({ items: [], nextCursor: 'C', until: 'C', hasMore: false });
  expect(completed).toBe(true);
});

it('merges three ascending pages and completes without moving H', () => {
  const sequences: string[] = []; let completed = false;
  service.recover('channel', 'C').subscribe({ next: page => sequences.push(...page.items.map(row => row.sequence)), complete: () => { completed = true; } });
  for (let i = 1; i <= 3; i++) {
    const after = i === 1 ? 'C' : `page${i - 1}`;
    http.expectOne(`/api/channels/channel/messages/sync?after=${after}${i === 1 ? '' : '&until=H'}`)
      .flush({ items: [{ ...item, id: String(i), sequence: String(i) }], nextCursor: i === 3 ? 'H' : `page${i}`, until: 'H', hasMore: i < 3 });
  }
  expect(sequences).toEqual(['1', '2', '3']); expect(completed).toBe(true);
});

it('rejects malformed, foreign, duplicate, unordered and non-progressing pages', () => {
  const valid = { items: [item], nextCursor: 'H', until: 'H', hasMore: false };
  for (const page of [null, {}, { ...valid, hasMore: 'false' }, { ...valid, nextCursor: 'bad=' },
    { ...valid, nextCursor: 'other' }, { ...valid, items: [item, item] },
    { ...valid, items: [{ ...item, channelId: 'other' }] },
    { ...valid, items: [item, { ...item, id: 'lower', sequence: '9007199254740992' }] },
    { ...valid, items: [], hasMore: true, nextCursor: 'next' },
    { ...valid, hasMore: true, nextCursor: 'C' }, { ...valid, hasMore: true }]) {
    let rejected = false;
    service.recover('channel', 'C').subscribe({ error: () => { rejected = true; } });
    http.expectOne('/api/channels/channel/messages/sync?after=C').flush(page);
    expect(rejected).toBe(true);
  }
});

it('rejects changed H or repeated sequence on a subsequent page', () => {
  for (const second of [{ items: [], nextCursor: 'other', until: 'other', hasMore: false },
    { items: [item], nextCursor: 'H', until: 'H', hasMore: false }]) {
    let rejected = false;
    service.recover('channel', 'C').subscribe({ error: () => { rejected = true; } });
    http.expectOne('/api/channels/channel/messages/sync?after=C').flush({ items: [item], nextCursor: 'next', until: 'H', hasMore: true });
    http.expectOne('/api/channels/channel/messages/sync?after=next&until=H').flush(second);
    expect(rejected).toBe(true);
  }
});

it('times out a page without leaving the request active', async () => {
  vi.useFakeTimers(); let rejected = false;
  service.recover('channel', 'C').subscribe({ error: () => { rejected = true; } });
  const request = http.expectOne('/api/channels/channel/messages/sync?after=C');
  await vi.advanceTimersByTimeAsync(5000);
  expect(rejected).toBe(true); expect(request.cancelled).toBe(true);
});
