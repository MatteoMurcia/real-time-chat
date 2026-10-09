import { afterNextRender, ChangeDetectionStrategy, Component, ElementRef, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

@Component({
  selector: 'app-login',
  imports: [RouterLink],
  template: `
    <div class="auth-page">
      <p class="eyebrow">YOUR ACCOUNT</p>
      <h1 tabindex="-1">{{ registered ? 'Account created' : 'Sign in' }}</h1>
      @if (registered) { <p>Your registration is complete. You are not signed in yet.</p> }
      <p>Sign-in is not available yet.</p>
      <a routerLink="/">Back to overview</a>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Login {
  protected readonly registered = inject(ActivatedRoute).snapshot.queryParamMap.get('registered') === '1';
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  constructor() { afterNextRender(() => this.element.nativeElement.querySelector('h1')?.focus()); }
}
