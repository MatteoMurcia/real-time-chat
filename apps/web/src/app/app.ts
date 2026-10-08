import { ChangeDetectionStrategy, Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { timeout } from 'rxjs';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly status = signal<'loading' | 'online' | 'error'>('loading');

  ngOnInit(): void {
    this.checkConnection();
  }

  protected checkConnection(): void {
    this.status.set('loading');
    this.http.get<unknown>('/api/health/live').pipe(
      timeout(5000),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (body) => this.status.set(
        typeof body === 'object' && body !== null && 'status' in body && body.status === 'ok'
          ? 'online' : 'error',
      ),
      error: () => this.status.set('error'),
    });
  }
}
