import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ActivityService } from './activity.service';
import { RealtimeConnection } from './realtime-connection';

const token = `${'a'.repeat(64)}.1800000000.${'b'.repeat(64)}`;
let visibility: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  TestBed.configureTestingModule({ providers: [ActivityService, provideHttpClient(), provideHttpClientTesting(),
    { provide: RealtimeConnection, useValue: { status: signal('connected'), listen: () => vi.fn() } }] });
});
afterEach(() => {
  try { TestBed.inject(HttpTestingController).verify(); }
  finally { TestBed.resetTestingModule(); vi.restoreAllMocks(); }
});

it('coalesces reached boundaries and trusts the server maximum across stale tabs', () => {
  const activity = TestBed.inject(ActivityService), http = TestBed.inject(HttpTestingController);
  activity.mark('one', '3'); activity.mark('one', '10'); activity.mark('one', '4');
  http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  const first = http.expectOne('/api/channels/one/read-cursor');
  expect(first.request.body).toEqual({ lastReadSequence: '3' });
  first.flush({ channelId: 'one', lastReadSequence: '8' });
  http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  const queued = http.expectOne('/api/channels/one/read-cursor');
  expect(queued.request.body).toEqual({ lastReadSequence: '10' });
  queued.flush({ channelId: 'one', lastReadSequence: '12' });
  activity.mark('one', '11'); http.expectNone('/api/auth/session/csrf');
});

it('does not write from a hidden tab or send a queued advance after it becomes hidden', () => {
  const activity = TestBed.inject(ActivityService), http = TestBed.inject(HttpTestingController);
  visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
  activity.mark('one', '1'); http.expectNone('/api/auth/session/csrf');
  visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
  activity.mark('one', '1'); activity.mark('one', '2');
  http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
  http.expectOne('/api/channels/one/read-cursor').flush({ channelId: 'one', lastReadSequence: '1' });
  http.expectNone('/api/auth/session/csrf');
});

it.each([{ channelId: 'other', lastReadSequence: '3' }, { channelId: 'one', lastReadSequence: '2' },
  { channelId: 'one', lastReadSequence: '03' }, { channelId: 'one', lastReadSequence: '9223372036854775808' }])('keeps failed or malformed confirmations retryable: %o', body => {
  const activity = TestBed.inject(ActivityService), http = TestBed.inject(HttpTestingController);
  activity.mark('one', '3'); http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  http.expectOne('/api/channels/one/read-cursor').flush(body);
  expect(activity.readError()?.channelId).toBe('one');
  activity.mark('one', '3'); http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  http.expectOne('/api/channels/one/read-cursor').flush({ channelId: 'one', lastReadSequence: '3' });
  expect(activity.readError()).toBe(null);
});
