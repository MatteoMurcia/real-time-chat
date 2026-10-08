import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './app';

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [App],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
});

afterEach(() => {
  TestBed.inject(HttpTestingController).verify();
  vi.useRealTimers();
});

it('shows loading, an error and recovery through the retry button using the same origin', () => {
  const fixture = TestBed.createComponent(App);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const button = element.querySelector('button')!;
  expect(element.textContent).toContain('Checking connection');
  expect(button.disabled).toBe(true);
  http.expectOne({ method: 'GET', url: '/api/health/live' })
    .flush(null, { status: 503, statusText: 'Unavailable' });
  fixture.detectChanges();
  expect(element.textContent).toContain('Unable to reach the API');
  expect(button.disabled).toBe(false);
  button.click();
  fixture.detectChanges();
  expect(button.disabled).toBe(true);
  http.expectOne('/api/health/live').flush({ status: 'ok' });
  fixture.detectChanges();
  expect(element.textContent).toContain('API is reachable');
});

it('does not report an invalid successful response as online', () => {
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  TestBed.inject(HttpTestingController).expectOne('/api/health/live').flush({ status: 'unexpected' });
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Unable to reach the API');
});

it('times out a stalled request and cancels the pending HTTP operation', () => {
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  const request = TestBed.inject(HttpTestingController).expectOne('/api/health/live');
  vi.advanceTimersByTime(5000);
  fixture.detectChanges();
  expect(request.cancelled).toBe(true);
  expect(fixture.nativeElement.textContent).toContain('Unable to reach the API');
});
