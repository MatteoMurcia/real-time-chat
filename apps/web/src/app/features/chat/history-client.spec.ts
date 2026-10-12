import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { HistoryClient } from './history-client';

let client: HistoryClient, http: HttpTestingController;
const item = { id: 'message', channelId: 'channel', clientMessageId: 'key', sequence: '1', body: 'Hello',
  author: { id: 'user', displayName: 'Alice' }, createdAt: '2026-10-12T00:00:00Z' };
beforeEach(() => {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  client = TestBed.inject(HistoryClient); http = TestBed.inject(HttpTestingController);
});
afterEach(() => { http.verify(); TestBed.resetTestingModule(); });

it('requests the exact older boundary and accepts an ordered page', () => {
  let result: unknown;
  client.list('channel', 'older').subscribe(page => { result = page; });
  const request = http.expectOne('/api/channels/channel/messages?before=older');
  expect(request.request.method).toBe('GET');
  const page = { items: [item], olderCursor: null, snapshotCursor: 'snapshot' };
  request.flush(page); expect(result).toEqual(page);
});

it('rejects malformed, foreign, duplicate or unordered pages before updating state', () => {
  for (const page of [null, { items: [], olderCursor: null },
    { items: [item, item], olderCursor: null, snapshotCursor: 's' },
    { items: [{ ...item, channelId: 'other' }], olderCursor: null, snapshotCursor: 's' },
    { items: [{ ...item, sequence: '2' }, { ...item, id: 'second' }], olderCursor: null, snapshotCursor: 's' },
    { items: [], olderCursor: 'older', snapshotCursor: 's' }]) {
    let rejected = false;
    client.list('channel', null).subscribe({ error: () => { rejected = true; } });
    http.expectOne('/api/channels/channel/messages').flush(page);
    expect(rejected).toBe(true);
  }
});
