import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, provideRouter, Router, type RouterStateSnapshot, UrlTree } from '@angular/router';
import { Observable } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionStore } from './session.store';
import { authGuard } from './auth.guard';

const user = { id: 'test-user', email: 'person@example.test', displayName: 'María', createdAt: '2026-10-09T12:00:00.000Z' };
const session = () => ({ user, expiresAt: new Date(Date.now() + 60000).toISOString() });
beforeEach(() => TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] }));
afterEach(() => { TestBed.inject(HttpTestingController).verify(); TestBed.resetTestingModule(); vi.useRealTimers(); });

function guard() {
  const result = TestBed.runInInjectionContext(() => authGuard(new ActivatedRouteSnapshot(), {} as RouterStateSnapshot));
  if (!(result instanceof Observable)) throw new Error('Expected an asynchronous session check');
  return result;
}

it('waits for the server before allowing a route and retains only public fields in memory', () => {
  const store = TestBed.inject(SessionStore);
  const allowed = vi.fn();
  guard().subscribe(allowed);
  expect(store.status()).toBe('checking');
  expect(allowed).not.toHaveBeenCalled();
  const body = session();
  TestBed.inject(HttpTestingController).expectOne('/api/auth/me').flush({ ...body, token: 'private', user: { ...user, passwordHash: 'private' } });
  expect(allowed).toHaveBeenCalledWith(true);
  expect(store.session()).toEqual(body);
  expect(store.status()).toBe('authenticated');
});

it('redirects a 401 once to public login and distinguishes an unavailable server', () => {
  const http = TestBed.inject(HttpTestingController);
  const router = TestBed.inject(Router);
  for (const [status, reason] of [[401, 'required'], [503, 'unavailable']] as const) {
    let target = '';
    guard().subscribe(value => { expect(value).toBeInstanceOf(UrlTree); target = router.serializeUrl(value as UrlTree); });
    http.expectOne('/api/auth/me').flush(null, { status, statusText: 'Failure' });
    expect(target).toBe(`/login?reason=${reason}`);
    expect(TestBed.inject(SessionStore).session()).toBeNull();
    http.expectNone('/api/auth/me');
  }
});

it('clears the cached identity when restoration returns a malformed body', () => {
  const store = TestBed.inject(SessionStore);
  const http = TestBed.inject(HttpTestingController);
  store.restore().subscribe();
  http.expectOne('/api/auth/me').flush(session());
  const failed = vi.fn();
  store.restore().subscribe({ error: failed });
  http.expectOne('/api/auth/me').flush({ user, expiresAt: 'invalid' });
  expect(failed).toHaveBeenCalledOnce();
  expect(store.status()).toBe('error');
  expect(store.session()).toBeNull();
});

it('clears identity at absolute expiry and never restores an already expired response', () => {
  vi.useFakeTimers();
  const store = TestBed.inject(SessionStore);
  const http = TestBed.inject(HttpTestingController);
  store.restore().subscribe();
  const body = session();
  http.expectOne('/api/auth/me').flush(body);
  vi.advanceTimersByTime(60000);
  expect(store.session()).toBeNull();
  expect(store.status()).toBe('anonymous');
  const restored = vi.fn();
  store.restore().subscribe(restored);
  http.expectOne('/api/auth/me').flush(body);
  expect(restored).toHaveBeenCalledWith(null);
});

it('times out a stalled restoration without retrying or treating it as a 401', () => {
  vi.useFakeTimers();
  const store = TestBed.inject(SessionStore);
  store.restore().subscribe({ error: () => undefined });
  const request = TestBed.inject(HttpTestingController).expectOne('/api/auth/me');
  vi.advanceTimersByTime(5000);
  expect(request.cancelled).toBe(true);
  expect(store.status()).toBe('error');
  expect(store.session()).toBeNull();
});

const csrfToken = `${'a'.repeat(64)}.1800000000.${'b'.repeat(64)}`;

it('clears identity on confirmed logout and ignores an older restoration response', () => {
  vi.useFakeTimers();
  const store = TestBed.inject(SessionStore);
  const http = TestBed.inject(HttpTestingController);
  store.restore().subscribe();
  http.expectOne('/api/auth/me').flush(session());
  store.restore().subscribe();
  const stale = http.expectOne('/api/auth/me');
  store.logout().subscribe();
  http.expectOne('/api/auth/session/csrf').flush({ csrfToken });
  const logout = http.expectOne('/api/auth/logout');
  expect(logout.request.method).toBe('POST');
  expect(logout.request.headers.get('X-CSRF-Token')).toBe(csrfToken);
  expect(store.session()).not.toBeNull();
  logout.flush(null, { status: 204, statusText: 'No Content' });
  stale.flush(session());
  expect(store.session()).toBeNull();
  expect(store.status()).toBe('signed-out');
  vi.advanceTimersByTime(60000);
  expect(store.status()).toBe('signed-out');
});

it('keeps identity on uncertain logout, does not retry and accepts an already invalid session', () => {
  vi.useFakeTimers();
  const store = TestBed.inject(SessionStore);
  const http = TestBed.inject(HttpTestingController);
  store.restore().subscribe();
  http.expectOne('/api/auth/me').flush(session());
  for (const failure of ['forbidden', 'server', 'timeout'] as const) {
    const error = vi.fn();
    store.logout().subscribe({ error });
    http.expectOne('/api/auth/session/csrf').flush({ csrfToken });
    const request = http.expectOne('/api/auth/logout');
    if (failure === 'timeout') { vi.advanceTimersByTime(15000); expect(request.cancelled).toBe(true); }
    else request.flush(null, { status: failure === 'forbidden' ? 403 : 503, statusText: 'Failure' });
    expect(error).toHaveBeenCalledOnce();
    expect(store.session()).not.toBeNull();
    http.expectNone('/api/auth/logout');
  }
  store.logout().subscribe();
  http.expectOne('/api/auth/session/csrf').flush(null, { status: 401, statusText: 'Unauthorized' });
  http.expectNone('/api/auth/logout');
  expect(store.session()).toBeNull();
  expect(store.status()).toBe('signed-out');
});
