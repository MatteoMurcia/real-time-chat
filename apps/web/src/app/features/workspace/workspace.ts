import { afterNextRender, ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, effect, ElementRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import { Router, RouterLink } from '@angular/router';
import { SessionStore } from '../../core/session.store';

@Component({
  selector: 'app-workspace',
  imports: [RouterLink],
  template: `
    @if (sessions.session(); as current) {
      <p class="eyebrow">YOUR WORKSPACE</p>
      <h1 tabindex="-1">Welcome, {{ current.user.displayName }}</h1>
      <p>Signed in as {{ current.user.email }}.</p>
      <button type="button" (click)="logout()" [disabled]="pending()">{{ pending() ? 'Signing out…' : 'Sign out' }}</button>
      @if (pending()) { <p role="status">Closing your session. Please wait.</p> }
      @if (message()) { <p id="logout-error" class="error-summary" role="alert" tabindex="-1">{{ message() }}</p> }
      <section aria-labelledby="conversations-title">
        <h2 id="conversations-title">Conversations</h2>
        <p>Your team’s conversations will appear here. Messaging is not available yet.</p>
        <a routerLink="/">Back to overview</a>
      </section>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Workspace {
  protected readonly sessions = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  protected readonly pending = signal(false);
  protected readonly message = signal('');

  constructor() {
    afterNextRender(() => this.element.nativeElement.querySelector('h1')?.focus());
    effect(() => {
      if (this.sessions.status() === 'anonymous') void this.router.navigate(['/login'], { queryParams: { reason: 'expired' } });
      if (this.sessions.status() === 'signed-out') void this.router.navigate(['/login'], { queryParams: { reason: 'signed-out' } });
    });
  }

  protected logout(): void {
    if (this.pending()) return;
    this.pending.set(true);
    this.message.set('');
    this.sessions.logout().pipe(takeUntilDestroyed(this.destroyRef), finalize(() => this.pending.set(false))).subscribe({
      error: () => {
        this.message.set('We could not confirm sign-out. Check your connection and try again.');
        this.changeDetector.detectChanges();
        this.element.nativeElement.querySelector<HTMLElement>('#logout-error')?.focus();
      },
    });
  }
}
