import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Login } from './login';
import { SessionStore } from '../../core/session.store';

const token = `${'a'.repeat(64)}.1800000000.${'b'.repeat(64)}`;
beforeEach(() => TestBed.configureTestingModule({ imports: [Login], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] }));
afterEach(() => { TestBed.inject(HttpTestingController).verify(); TestBed.resetTestingModule(); vi.useRealTimers(); });

function setup() {
  const fixture = TestBed.createComponent(Login);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const fill = (id: string, value: string) => {
    const input = element.querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const submit = () => { element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); fixture.detectChanges(); };
  return { fixture, element, fill, submit, http: TestBed.inject(HttpTestingController) };
}

it('validates, prevents double submit, preserves the password and clears it before navigation', () => {
  const { fixture, element, fill, submit, http } = setup();
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  submit();
  expect(element.querySelector('#login-email')!.getAttribute('aria-invalid')).toBe('true');
  http.expectNone('/api/auth/csrf');
  fill('login-email', ' Person@Example.test ');
  fill('login-password', ' a long passphrase ');
  submit(); submit();
  expect(element.querySelector('button')!.disabled).toBe(true);
  http.expectOne('/api/auth/csrf').flush({ csrfToken: token });
  const request = http.expectOne('/api/auth/login');
  expect(request.request.headers.get('X-CSRF-Token')).toBe(token);
  expect(request.request.body.password).toBe(' a long passphrase ');
  request.flush({ user: { id: 'test', email: 'person@example.test', displayName: 'Person', createdAt: '2026-10-09T12:00:00Z' }, expiresAt: new Date(Date.now() + 60000).toISOString() });
  fixture.detectChanges();
  expect(navigate).toHaveBeenCalledWith(['/workspace']);
  expect(TestBed.inject(SessionStore).status()).toBe('authenticated');
  expect(element.querySelector<HTMLInputElement>('#login-password')!.value).toBe('');
});

it('uses safe text for incorrect credentials and obtains fresh CSRF on retry', () => {
  const { fixture, element, fill, submit, http } = setup();
  fill('login-email', 'person@example.test'); fill('login-password', 'wrong'); submit();
  http.expectOne('/api/auth/csrf').flush({ csrfToken: token });
  http.expectOne('/api/auth/login').flush({ message: 'private detail' }, { status: 401, statusText: 'Unauthorized' });
  fixture.detectChanges();
  expect(element.textContent).toContain('Email or password is incorrect.');
  expect(element.textContent).not.toContain('private detail');
  expect(element.querySelector('button')!.disabled).toBe(false);
  submit();
  http.expectOne('/api/auth/csrf').flush(null, { status: 503, statusText: 'Unavailable' });
  fixture.detectChanges();
  expect(element.textContent).toContain('could not confirm sign-in');
  expect(element.textContent).not.toContain('Email or password is incorrect.');
});

it('does not automatically retry an uncertain login and cancels work when leaving the form', () => {
  vi.useFakeTimers();
  const { fixture, element, fill, submit, http } = setup();
  fill('login-email', 'person@example.test'); fill('login-password', 'password'); submit();
  http.expectOne('/api/auth/csrf').flush({ csrfToken: token });
  const request = http.expectOne('/api/auth/login');
  vi.advanceTimersByTime(15000);
  fixture.detectChanges();
  expect(request.cancelled).toBe(true);
  expect(element.textContent).toContain('could not confirm sign-in');
  http.expectNone('/api/auth/login');
  submit();
  const bootstrap = http.expectOne('/api/auth/csrf');
  fixture.destroy();
  expect(bootstrap.cancelled).toBe(true);
});
