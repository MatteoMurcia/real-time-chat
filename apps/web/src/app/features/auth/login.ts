import { afterNextRender, ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, DestroyRef, ElementRef, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, type AbstractControl } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import { isApiError } from '@real-time-chat/contracts';
import { SessionStore } from '../../core/session.store';

@Component({
  selector: 'app-login',
  imports: [RouterLink, ReactiveFormsModule],
  templateUrl: './login.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Login {
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap, { requireSync: true });
  protected readonly registered = computed(() => this.params().get('registered') === '1');
  protected readonly reason = computed(() => this.params().get('reason'));
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly sessions = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  protected readonly pending = signal(false);
  protected readonly message = signal('');
  protected readonly form = inject(FormBuilder).nonNullable.group({
    email: ['', (control: AbstractControl<string>) => control.value.trim().length > 0 && control.value.trim().length <= 254 ? null : { email: true }],
    password: ['', (control: AbstractControl<string>) => [...control.value].length > 0 && [...control.value].length <= 128 ? null : { password: true }],
  });

  constructor() { afterNextRender(() => this.element.nativeElement.querySelector('h1')?.focus()); }

  protected invalid(field: 'email' | 'password'): boolean {
    return this.form.controls[field].touched && this.form.controls[field].invalid;
  }

  protected submit(): void {
    if (this.pending()) return;
    this.message.set('');
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      const field = this.form.controls.email.invalid ? 'login-email' : 'login-password';
      this.element.nativeElement.querySelector<HTMLInputElement>(`#${field}`)?.focus();
      return;
    }
    this.pending.set(true);
    this.sessions.login(this.form.getRawValue()).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.pending.set(false)),
    ).subscribe({
      next: session => {
        this.form.reset();
        if (session) void this.router.navigate(['/workspace']);
        else this.showError('Your session expired. Please sign in again.');
      },
      error: (error: unknown) => {
        const code = error instanceof HttpErrorResponse && isApiError(error.error) ? error.error.code : null;
        if (error instanceof HttpErrorResponse && error.status === 401) {
          this.showError('Email or password is incorrect.');
        } else if (code === 'FORBIDDEN') {
          this.showError('Your security check expired. Please try again.');
        } else if (code === 'RATE_LIMITED') {
          this.showError('Too many attempts. Wait a moment before trying again.');
        } else {
          this.showError('We could not confirm sign-in. Check your connection and try opening your workspace before signing in again.');
        }
      },
    });
  }

  private showError(message: string): void {
    this.message.set(message);
    this.changeDetector.detectChanges();
    this.element.nativeElement.querySelector<HTMLElement>('#login-error')?.focus();
  }
}
