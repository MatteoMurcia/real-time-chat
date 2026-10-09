import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Overview } from './overview';

beforeEach(() => {
  TestBed.configureTestingModule({
    imports: [Overview],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
});

afterEach(() => {
  TestBed.inject(HttpTestingController).verify();
  vi.useRealTimers();
});

it('shows loading, an error and recovery through the retry button using the same origin', () => {
  const fixture = TestBed.createComponent(Overview);
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
  const fixture = TestBed.createComponent(Overview);
  fixture.detectChanges();
  TestBed.inject(HttpTestingController).expectOne('/api/health/live').flush({ status: 'unexpected' });
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Unable to reach the API');
});

it('times out a stalled request and cancels the pending HTTP operation', () => {
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(Overview);
  fixture.detectChanges();
  const request = TestBed.inject(HttpTestingController).expectOne('/api/health/live');
  vi.advanceTimersByTime(5000);
  fixture.detectChanges();
  expect(request.cancelled).toBe(true);
  expect(fixture.nativeElement.textContent).toContain('Unable to reach the API');
});

it('uses a validated error code instead of server text and clears it on retry', () => {
  const fixture = TestBed.createComponent(Overview);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  http.expectOne('/api/health/live').flush({
    code: 'RATE_LIMITED', message: '<script>private server detail</script>',
    requestId: 'e3028dab-3a9d-4b02-9e28-d3b645f6a583',
  }, { status: 429, statusText: 'Too Many Requests' });
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Too many checks');
  expect(fixture.nativeElement.textContent).not.toContain('private server detail');
  fixture.nativeElement.querySelector('button').click();
  http.expectOne('/api/health/live').flush(null, { status: 502, statusText: 'Bad Gateway' });
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Unable to reach the API');
  expect(fixture.nativeElement.textContent).not.toContain('Too many checks');
});

it('handles safe internal errors and rejects malformed contract bodies', () => {
  const fixture = TestBed.createComponent(Overview);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  http.expectOne('/api/health/live').flush({
    code: 'INTERNAL_ERROR', message: 'Private text',
    requestId: 'e3028dab-3a9d-4b02-9e28-d3b645f6a583',
  }, { status: 500, statusText: 'Server Error' });
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('The server could not complete the check');
  fixture.nativeElement.querySelector('button').click();
  http.expectOne('/api/health/live').flush({ code: 'RATE_LIMITED', message: 'Missing request ID' },
    { status: 429, statusText: 'Too Many Requests' });
  fixture.detectChanges();
  expect(fixture.nativeElement.textContent).toContain('Unable to reach the API');
});
