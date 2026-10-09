import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, ElementRef, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, type ValidatorFn } from '@angular/forms';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import { isApiError } from '@real-time-chat/contracts';
import type { FieldErrors, RegistrationField } from '@real-time-chat/contracts/auth';
import { AuthClient } from '../../core/auth-client';

const length = (min: number, max: number, trim = false): ValidatorFn => control => {
  const value = trim ? String(control.value).trim().normalize('NFC') : String(control.value);
  return [...value].length >= min && [...value].length <= max ? null : { length: true };
};
const messages = {
  displayName: 'Use 2–80 letters, numbers, spaces, apostrophes, periods or hyphens.',
  email: 'Enter a valid email address.',
  password: 'Use 15–128 characters.',
};

@Component({
  selector: 'app-register',
  imports: [ReactiveFormsModule],
  templateUrl: './register.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Register {
  private readonly client = inject(AuthClient);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  protected readonly form = inject(FormBuilder).nonNullable.group({
    displayName: ['', [length(2, 80, true), control => /^[\p{L}\p{M}\p{N} .'-]+$/u.test(control.value) ? null : { name: true }]],
    email: ['', [length(3, 254, true), control => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(control.value.trim()) ? null : { email: true }]],
    password: ['', length(15, 128)],
  });
  protected readonly pending = signal(false);
  protected readonly message = signal('');
  private readonly serverFields = signal<FieldErrors>({});

  protected error(field: RegistrationField): string {
    const control = this.form.controls[field];
    return this.serverFields()[field] ?? (control.touched && control.invalid ? messages[field] : '');
  }

  protected edited(field: RegistrationField): void {
    this.serverFields.update(fields => ({ ...fields, [field]: undefined }));
    this.message.set('');
  }

  protected submit(): void {
    if (this.pending()) return;
    this.message.set('');
    this.serverFields.set({});
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      const field = (Object.keys(this.form.controls) as RegistrationField[]).find(key => this.form.controls[key].invalid);
      this.element.nativeElement.querySelector<HTMLInputElement>(`#${field}`)?.focus();
      return;
    }
    this.pending.set(true);
    this.client.register(this.form.getRawValue()).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.pending.set(false)),
    ).subscribe({
      next: () => {
        this.form.reset();
        void this.router.navigate(['/login'], { queryParams: { registered: '1' } });
      },
      error: (error: unknown) => {
        const apiError = error instanceof HttpErrorResponse && isApiError(error.error) ? error.error : null;
        if (apiError?.code === 'VALIDATION_ERROR') {
          this.serverFields.set(Object.fromEntries(Object.keys(apiError.fieldErrors ?? {}).map(field => [field, messages[field as RegistrationField]])));
          this.message.set('Check your details and try again.');
        } else if (apiError?.code === 'CONFLICT') {
          this.serverFields.set({ email: 'An account already uses this email address.' });
          this.message.set('An account already uses this email address.');
        } else if (apiError?.code === 'FORBIDDEN') {
          this.message.set('Your security check expired. Please try again.');
        } else if (apiError?.code === 'RATE_LIMITED') {
          this.message.set('Too many attempts. Wait a moment before trying again.');
        } else {
          this.message.set('We could not confirm your registration. Your account may have been created. Check your connection before trying again.');
        }
        this.changeDetector.detectChanges();
        this.element.nativeElement.querySelector<HTMLElement>('#registration-error')?.focus();
      },
    });
  }
}
