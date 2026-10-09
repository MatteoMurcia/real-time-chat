import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Register } from './register';

const token = `${'a'.repeat(64)}.1800000000.${'b'.repeat(64)}`;
const requestId = 'e3028dab-3a9d-4b02-9e28-d3b645f6a583';
beforeEach(() => TestBed.configureTestingModule({
  imports: [Register], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
}));
afterEach(() => { TestBed.inject(HttpTestingController).verify(); vi.useRealTimers(); });

function setup() {
  const fixture = TestBed.createComponent(Register);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  const fill = (name: string, value: string) => {
    const input = element.querySelector<HTMLInputElement>(`#${name}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const submit = () => { element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); fixture.detectChanges(); };
  const valid = () => { fill('displayName', 'María'); fill('email', 'person@example.test'); fill('password', 'a long unique passphrase'); };
  return { fixture, element, http, fill, submit, valid };
}

it('validates before sending and sends only once after a fresh CSRF bootstrap', async () => {
  const { fixture, element, http, submit, valid } = setup();
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  submit();
  expect(element.querySelector('#password-error')!.textContent).toContain('15–128');
  http.expectNone('/api/auth/csrf');
  valid(); submit(); submit();
  expect(element.querySelector('button')!.disabled).toBe(true);
  http.expectOne('/api/auth/csrf').flush({ csrfToken: token });
  const request = http.expectOne({ method: 'POST', url: '/api/auth/register' });
  expect(request.request.headers.get('X-CSRF-Token')).toBe(token);
  expect(request.request.body).toEqual({ displayName: 'María', email: 'person@example.test', password: 'a long unique passphrase' });
  request.flush({ user: { id: 'test-user', email: 'person@example.test', displayName: 'María', createdAt: '2026-10-09T12:00:00.000Z' } });
  fixture.detectChanges();
  expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { registered: '1' } });
  expect(element.querySelector<HTMLInputElement>('#password')!.value).toBe('');
});

it('maps server fields to local text and recovers with a new token after conflict', () => {
  const { fixture, element, http, submit, valid, fill } = setup();
  valid(); submit();
  http.expectOne('/api/auth/csrf').flush({ csrfToken: token });
  http.expectOne('/api/auth/register').flush({ code: 'VALIDATION_ERROR', requestId, message: 'private', fieldErrors: { email: '<script>private</script>' } }, { status: 400, statusText: 'Bad Request' });
  fixture.detectChanges();
  expect(element.textContent).toContain('Enter a valid email');
  expect(element.textContent).not.toContain('private');
  fill('email', 'other@example.test'); submit();
  http.expectOne('/api/auth/csrf').flush({ csrfToken: token });
  http.expectOne('/api/auth/register').flush({ code: 'CONFLICT', requestId, message: 'private' }, { status: 409, statusText: 'Conflict' });
  fixture.detectChanges();
  expect(element.textContent).toContain('An account already uses this email');
  expect(element.querySelector('button')!.disabled).toBe(false);
});

it('rejects malformed token responses and safely times out without retrying registration', () => {
  vi.useFakeTimers();
  const { fixture, element, http, submit, valid } = setup();
  valid(); submit();
  http.expectOne('/api/auth/csrf').flush({ csrfToken: 'invalid' });
  fixture.detectChanges();
  http.expectNone('/api/auth/register');
  expect(element.textContent).toContain('could not confirm');
  submit();
  http.expectOne('/api/auth/csrf').flush({ csrfToken: token });
  const request = http.expectOne('/api/auth/register');
  vi.advanceTimersByTime(15000);
  fixture.detectChanges();
  expect(request.cancelled).toBe(true);
  expect(element.querySelector('button')!.disabled).toBe(false);
  expect(element.textContent).toContain('may have been created');
  http.expectNone('/api/auth/csrf');
});
