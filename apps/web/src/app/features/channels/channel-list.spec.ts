import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChannelList } from './channel-list';
import { signal } from '@angular/core';
import { ActivityService } from '../../core/activity.service';

const channel = { id: 'channel-id', name: 'Design', slug: 'design-team', createdAt: '2026-10-10T12:00:00Z', isMember: true, unreadCount: 0 };
const token = `${'a'.repeat(64)}.1800000000.${'b'.repeat(64)}`;
beforeEach(() => TestBed.configureTestingModule({ imports: [ChannelList], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), { provide: ActivityService, useValue: { revision: signal(0) } }] }));
afterEach(() => { try { TestBed.inject(HttpTestingController).verify(); } finally { TestBed.resetTestingModule(); vi.useRealTimers(); } });

function setup() {
  const fixture = TestBed.createComponent(ChannelList);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  const fill = (id: string, value: string) => {
    const input = element.querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = value; input.dispatchEvent(new Event('input'));
  };
  const submit = () => { element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); fixture.detectChanges(); };
  const click = (text: string) => { [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === text)!.click(); fixture.detectChanges(); };
  return { fixture, element, http, fill, submit, click };
}

it('shows a safe quota rejection and preserves creation input without retrying', () => {
  const { fixture, element, http, fill, submit } = setup();
  http.expectOne('/api/channels').flush({ channels: [], nextCursor: null });
  fill('channel-name', 'Design'); fill('channel-slug', 'design-team'); submit();
  http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  http.expectOne('/api/channels').flush({ code: 'RATE_LIMITED', message: 'private', requestId: '12345678-1234-4234-8234-123456789abc' }, { status: 429, statusText: 'Too Many Requests' });
  fixture.detectChanges();
  expect(element.textContent).toContain('Too many channel creation attempts. Try again later.');
  expect(element.querySelector<HTMLInputElement>('#channel-name')!.value).toBe('Design');
  expect(element.textContent).not.toContain('private'); http.expectNone('/api/auth/session/csrf');
});

it('validates locally, posts once with session CSRF and refreshes after confirmed creation', () => {
  const { fixture, element, http, fill, submit } = setup();
  http.expectOne('/api/channels').flush({ channels: [], nextCursor: null });
  submit(); http.expectNone('/api/auth/session/csrf');
  expect(element.querySelector('#channel-name')!.getAttribute('aria-invalid')).toBe('true');
  fill('channel-name', 'Design'); fill('channel-slug', 'design-team');
  submit(); submit();
  http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  const post = http.expectOne('/api/channels');
  expect(post.request.method).toBe('POST');
  expect(post.request.headers.get('X-CSRF-Token')).toBe(token);
  expect(post.request.body).toEqual({ name: 'Design', slug: 'design-team' });
  post.flush({ channel });
  http.expectOne('/api/channels').flush({ channels: [channel], nextCursor: null });
  fixture.detectChanges();
  expect(element.textContent).toContain('Created #design-team. You are a member.');
  expect(element.querySelector<HTMLInputElement>('#channel-name')!.value).toBe('');
  expect(element.querySelector('li')!.textContent).toContain('Member');
});

it('keeps the current page on failure and allows pagination and refresh without duplicates', () => {
  const { fixture, element, http, click } = setup();
  http.expectOne('/api/channels').flush({ channels: [channel], nextCursor: 'djE6ZGVzaWdu' }); fixture.detectChanges();
  click('Next channels');
  http.expectOne('/api/channels?cursor=djE6ZGVzaWdu').flush(null, { status: 503, statusText: 'Unavailable' }); fixture.detectChanges();
  expect(element.querySelector('li')!.textContent).toContain('Design');
  expect(element.textContent).toContain('Could not load channels');
  click('Next channels');
  http.expectOne('/api/channels?cursor=djE6ZGVzaWdu').flush({ channels: [{ ...channel, id: 'other', name: 'Engineering', isMember: false, unreadCount: null }], nextCursor: null }); fixture.detectChanges();
  expect(element.querySelectorAll('li')).toHaveLength(1);
  expect(document.activeElement).toBe(element.querySelector('#channels-title'));
  expect(element.querySelector('li')!.textContent).toContain('Open channel');
  click('Back to first page');
  http.expectOne('/api/channels').flush({ channels: [], nextCursor: null }); fixture.detectChanges();
  expect(element.textContent).toContain('No channels yet');
});

it('does not retry uncertain creation, preserves input and cancels requests on destruction', () => {
  vi.useFakeTimers();
  const { fixture, element, http, fill, submit, click } = setup();
  http.expectOne('/api/channels').flush({ channels: [], nextCursor: null });
  fill('channel-name', 'Design'); fill('channel-slug', 'design-team'); submit();
  http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  const post = http.expectOne('/api/channels');
  vi.advanceTimersByTime(15000); fixture.detectChanges();
  expect(post.cancelled).toBe(true);
  expect(element.textContent).toContain('channel may already exist');
  expect(element.querySelector<HTMLInputElement>('#channel-name')!.value).toBe('Design');
  http.expectNone('/api/auth/session/csrf');
  click('Refresh channels'); const pending = http.expectOne('/api/channels'); fixture.destroy();
  expect(pending.cancelled).toBe(true);
});

it('rejects malformed pages and sends revoked sessions back to login', () => {
  const { fixture, element, http, click } = setup();
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  http.expectOne('/api/channels').flush({ channels: [{ ...channel, isMember: 'yes' }], nextCursor: null }); fixture.detectChanges();
  expect(element.textContent).toContain('Could not load channels');
  click('Refresh channels');
  http.expectOne('/api/channels').flush(null, { status: 401, statusText: 'Unauthorized' });
  expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { reason: 'expired' } });
});

it('confirms membership changes before updating and blocks overlapping reads or mutations', () => {
  const { fixture, element, http, click } = setup();
  http.expectOne('/api/channels').flush({ channels: [channel], nextCursor: null }); fixture.detectChanges();
  click('Leave'); click('Refresh channels');
  http.expectNone('/api/channels');
  expect(element.querySelector('li')!.textContent).toContain('Member');
  expect(element.querySelector<HTMLButtonElement>('#membership-channel-id')!.disabled).toBe(true);
  http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  const request = http.expectOne('/api/channels/channel-id/membership');
  expect(request.request.method).toBe('DELETE');
  expect(request.request.body).toBe(null);
  expect(request.request.headers.get('X-CSRF-Token')).toBe(token);
  request.flush({ channelId: channel.id, isMember: false }); fixture.detectChanges();
  http.expectOne('/api/channels').flush({ channels: [{ ...channel, isMember: false, unreadCount: null }], nextCursor: null });
  expect(element.querySelector('li')!.textContent).toContain('Open channel');
  expect(document.activeElement).toBe(element.querySelector('#membership-channel-id'));
  click('Join');
  http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  const join = http.expectOne('/api/channels/channel-id/membership');
  expect(join.request.method).toBe('PUT'); join.flush({ channelId: channel.id, isMember: true }); fixture.detectChanges();
  http.expectOne('/api/channels').flush({ channels: [channel], nextCursor: null });
  expect(element.querySelector('li')!.textContent).toContain('Member');
});

it('retains the original action after timeout and requires explicit retry or refreshed state', () => {
  vi.useFakeTimers();
  const { fixture, element, http, click } = setup();
  http.expectOne('/api/channels').flush({ channels: [channel], nextCursor: null }); fixture.detectChanges();
  click('Leave'); http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  const lost = http.expectOne('/api/channels/channel-id/membership');
  vi.advanceTimersByTime(15000); fixture.detectChanges();
  expect(lost.cancelled).toBe(true);
  expect(element.querySelector('li')!.textContent).toContain('Status unconfirmed');
  http.expectNone('/api/auth/session/csrf');
  click('Retry'); http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  const retry = http.expectOne('/api/channels/channel-id/membership');
  expect(retry.request.method).toBe('DELETE');
  retry.flush({ channelId: 'different-channel', isMember: false }); fixture.detectChanges();
  expect(element.textContent).toContain('Membership could not be confirmed');
  click('Refresh channels');
  http.expectOne('/api/channels').flush({ channels: [{ ...channel, isMember: false, unreadCount: null }], nextCursor: null }); fixture.detectChanges();
  expect(element.textContent).not.toContain('Status unconfirmed');
  expect(element.querySelector('li')!.textContent).toContain('Open channel');
});

it('cancels an in-flight membership request when leaving the workspace', () => {
  const { fixture, http, click } = setup();
  http.expectOne('/api/channels').flush({ channels: [channel], nextCursor: null }); fixture.detectChanges();
  click('Leave'); http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  const request = http.expectOne('/api/channels/channel-id/membership'); fixture.destroy();
  expect(request.cancelled).toBe(true);
});

it('refreshes counts without moving focus, cancels stale reads before leave and hides failed counts', () => {
  const { fixture, element, http, click } = setup();
  http.expectOne('/api/channels').flush({ channels: [{ ...channel, unreadCount: 2 }], nextCursor: null }); fixture.detectChanges();
  expect(element.textContent).toContain('2 unread');
  const activity = TestBed.inject(ActivityService);
  activity.revision.update(value => value + 1); fixture.detectChanges();
  const stale = http.expectOne('/api/channels');
  click('Leave'); expect(stale.cancelled).toBe(true);
  http.expectOne('/api/auth/session/csrf').flush({ csrfToken: token });
  http.expectOne('/api/channels/channel-id/membership').flush({ channelId: channel.id, isMember: false }); fixture.detectChanges();
  http.expectOne('/api/channels').flush({ channels: [{ ...channel, isMember: false, unreadCount: null }], nextCursor: null }); fixture.detectChanges();
  expect(element.textContent).not.toContain('2 unread');
  expect(document.activeElement).toBe(element.querySelector('#membership-channel-id'));
  activity.revision.update(value => value + 1); fixture.detectChanges();
  http.expectOne('/api/channels').flush(null, { status: 503, statusText: 'Unavailable' }); fixture.detectChanges();
  expect(element.textContent).toContain('Unread counts are unavailable');
});

it.each([-1, 1.5, '3', undefined, Number.MAX_SAFE_INTEGER + 1])('rejects invalid unread counts: %s', unreadCount => {
  const { fixture, element, http } = setup();
  http.expectOne('/api/channels').flush({ channels: [{ ...channel, unreadCount }], nextCursor: null }); fixture.detectChanges();
  expect(element.textContent).toContain('Could not load channels');
});
