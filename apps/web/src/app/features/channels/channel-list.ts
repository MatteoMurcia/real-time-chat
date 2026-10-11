import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, ElementRef, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, type AbstractControl } from '@angular/forms';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import { isApiError } from '@real-time-chat/contracts';
import type { PublicChannel } from '@real-time-chat/contracts/channels';
import { ChannelsClient } from './channels-client';

@Component({
  selector: 'app-channel-list',
  imports: [ReactiveFormsModule],
  templateUrl: './channel-list.html',
  styleUrl: './channel-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelList {
  private readonly client = inject(ChannelsClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly router = inject(Router);
  protected readonly channels = signal<PublicChannel[]>([]);
  protected readonly loading = signal(false);
  protected readonly pending = signal(false);
  protected readonly listError = signal('');
  protected readonly createError = signal('');
  protected readonly notice = signal('');
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly currentCursor = signal<string | null>(null);
  protected readonly form = inject(FormBuilder).nonNullable.group({
    name: ['', (control: AbstractControl<string>) => {
      const name = String(control.value).trim().normalize('NFC').replace(/ +/g, ' ');
      return [...name].length >= 2 && [...name].length <= 80 && /^[\p{L}\p{M}\p{N} .'-]+$/u.test(name) ? null : { name: true };
    }],
    slug: ['', (control: AbstractControl<string>) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(control.value.trim()) && control.value.trim().length >= 3 && control.value.trim().length <= 48 ? null : { slug: true }],
  });

  constructor() { this.load(); }

  protected load(cursor: string | null = null): void {
    if (this.loading() || this.pending()) return;
    this.loading.set(true);
    this.listError.set('');
    this.client.list(cursor).pipe(takeUntilDestroyed(this.destroyRef), finalize(() => this.loading.set(false))).subscribe({
      next: page => {
        const changedPage = cursor !== this.currentCursor();
        this.channels.set(page.channels); this.nextCursor.set(page.nextCursor); this.currentCursor.set(cursor);
        if (changedPage) {
          this.changeDetector.detectChanges();
          this.element.nativeElement.querySelector<HTMLElement>('#channels-title')?.focus();
        }
      },
      error: (error: unknown) => {
        this.handleUnauthorized(error);
        this.listError.set('Could not load channels. Try again.');
      },
    });
  }

  protected submit(): void {
    if (this.pending() || this.loading()) return;
    this.createError.set('');
    this.notice.set('');
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      this.element.nativeElement.querySelector<HTMLInputElement>(this.form.controls.name.invalid ? '#channel-name' : '#channel-slug')?.focus();
      return;
    }
    this.pending.set(true);
    this.client.create(this.form.getRawValue()).pipe(takeUntilDestroyed(this.destroyRef), finalize(() => this.pending.set(false))).subscribe({
      next: channel => {
        this.form.reset();
        this.notice.set(`Created #${channel.slug}. You are a member.`);
        this.pending.set(false);
        this.load();
        this.changeDetector.detectChanges();
        this.element.nativeElement.querySelector<HTMLElement>('#channel-notice')?.focus();
      },
      error: (error: unknown) => {
        this.handleUnauthorized(error);
        const api = error instanceof HttpErrorResponse && isApiError(error.error) ? error.error : null;
        this.createError.set(api?.code === 'CONFLICT' ? 'A channel already uses this name or slug.'
          : api?.code === 'VALIDATION_ERROR' ? 'Check the channel name and slug.'
          : api?.code === 'FORBIDDEN' ? 'Your security check expired. Please try again.'
          : 'We could not confirm creation. Refresh the list before trying again; the channel may already exist.');
        this.changeDetector.detectChanges();
        this.element.nativeElement.querySelector<HTMLElement>('#channel-error')?.focus();
      },
    });
  }

  private handleUnauthorized(error: unknown): void {
    if (error instanceof HttpErrorResponse && error.status === 401) void this.router.navigate(['/login'], { queryParams: { reason: 'expired' } });
  }
}
