import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import type { LoginRequest, SessionResponse } from '@real-time-chat/contracts/auth';
import { catchError, defer, finalize, map, of, tap, throwError } from 'rxjs';
import { AuthClient } from './auth-client';

@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly client = inject(AuthClient);
  private readonly current = signal<SessionResponse | null>(null);
  private readonly phase = signal<'unknown' | 'checking' | 'authenticated' | 'anonymous' | 'signed-out' | 'error'>('unknown');
  private revision = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly session = this.current.asReadonly();
  readonly status = this.phase.asReadonly();

  constructor() { inject(DestroyRef).onDestroy(() => clearTimeout(this.expiryTimer)); }

  login(input: LoginRequest) {
    return this.client.login(input).pipe(map(session => this.accept(session)));
  }

  logout() {
    return this.client.logout().pipe(
      catchError((error: unknown) => error instanceof HttpErrorResponse && error.status === 401
        ? of(undefined) : throwError(() => error)),
      tap(() => { this.clear(); this.phase.set('signed-out'); }),
    );
  }

  restore() {
    return defer(() => {
      const revision = this.revision;
      this.phase.set('checking');
      return this.client.me().pipe(
        map(session => revision === this.revision ? this.accept(session) : this.current()),
        catchError((error: unknown) => {
          if (revision !== this.revision) return of(this.current());
          this.clear();
          if (error instanceof HttpErrorResponse && error.status === 401) return of(null);
          this.phase.set('error');
          return throwError(() => error);
        }),
        finalize(() => { if (this.phase() === 'checking') this.phase.set('unknown'); }),
      );
    });
  }

  private accept(session: SessionResponse): SessionResponse | null {
    this.clear();
    if (Date.parse(session.expiresAt) <= Date.now()) return null;
    this.current.set(session);
    this.phase.set('authenticated');
    const expire = () => {
      const remaining = Date.parse(session.expiresAt) - Date.now();
      if (remaining <= 0) this.clear();
      else this.expiryTimer = setTimeout(expire, Math.min(remaining, 2147483647));
    };
    expire();
    return session;
  }

  private clear(): void {
    this.revision++;
    clearTimeout(this.expiryTimer);
    this.current.set(null);
    this.phase.set('anonymous');
  }
}
