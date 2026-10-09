import { afterNextRender, ChangeDetectionStrategy, Component, effect, ElementRef, inject } from '@angular/core';
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

  constructor() {
    afterNextRender(() => this.element.nativeElement.querySelector('h1')?.focus());
    effect(() => {
      if (this.sessions.status() === 'anonymous') void this.router.navigate(['/login'], { queryParams: { reason: 'expired' } });
    });
  }
}
