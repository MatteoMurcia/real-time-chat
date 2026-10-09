import { ChangeDetectionStrategy, Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { isApiError } from '@real-time-chat/contracts';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { timeout } from 'rxjs';

@Component({
  selector: 'app-overview',
  templateUrl: './overview.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Overview implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly status = signal<'loading' | 'online' | 'error'>('loading');
  protected readonly errorMessage = signal('Unable to reach the API. Check that it is running, then try again.');

  ngOnInit(): void {
    this.checkConnection();
  }

  protected checkConnection(): void {
    this.status.set('loading');
    this.errorMessage.set('Unable to reach the API. Check that it is running, then try again.');
    this.http.get<unknown>('/api/health/live').pipe(
      timeout(5000),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (body) => this.status.set(
        typeof body === 'object' && body !== null && 'status' in body && body.status === 'ok'
          ? 'online' : 'error',
      ),
      error: (error: unknown) => {
        if (error instanceof HttpErrorResponse && isApiError(error.error)) {
          this.errorMessage.set(error.error.code === 'RATE_LIMITED'
            ? 'Too many checks. Wait a moment, then try again.'
            : 'The server could not complete the check. Try again later.');
        }
        this.status.set('error');
      },
    });
  }
}
