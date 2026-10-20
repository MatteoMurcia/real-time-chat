import { DOCUMENT } from '@angular/common';
import { DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthClient } from './auth-client';
import { RealtimeConnection } from './realtime-connection';

@Injectable()
export class ActivityService {
  private readonly auth = inject(AuthClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  readonly revision = signal(0);
  readonly visible = signal(this.document.visibilityState === 'visible');
  readonly readError = signal<{ channelId: string; message: string } | null>(null);
  private readonly saved = new Map<string, bigint>();
  private readonly pending = new Map<string, bigint>();

  constructor() {
    const refresh = () => { if (this.visible()) this.revision.update(value => value + 1); };
    const visibility = () => { this.visible.set(this.document.visibilityState === 'visible'); refresh(); };
    const connection = inject(RealtimeConnection);
    const stop = connection.listen('activity:changed', refresh);
    this.document.defaultView?.addEventListener('focus', refresh);
    this.document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(refresh, 15000);
    effect(() => { if (connection.status() === 'connected') refresh(); });
    this.destroyRef.onDestroy(() => {
      stop(); clearInterval(timer);
      this.document.defaultView?.removeEventListener('focus', refresh);
      this.document.removeEventListener('visibilitychange', visibility);
    });
  }

  mark(channelId: string, sequence: string): void {
    if (!this.visible()) return;
    const reached = BigInt(sequence);
    if (reached <= (this.saved.get(channelId) ?? 0n)) return;
    const pending = this.pending.get(channelId);
    this.pending.set(channelId, reached > (pending ?? 0n) ? reached : pending!);
    if (pending !== undefined) return;
    this.auth.authenticatedRequest('PUT', `/api/channels/${encodeURIComponent(channelId)}/read-cursor`, { lastReadSequence: sequence })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: body => {
          if (!body || typeof body !== 'object' || !('channelId' in body) || body.channelId !== channelId
            || !('lastReadSequence' in body) || typeof body.lastReadSequence !== 'string'
            || !/^(?:0|[1-9]\d{0,18})$/.test(body.lastReadSequence)
            || BigInt(body.lastReadSequence) < reached || BigInt(body.lastReadSequence) > 9223372036854775807n) {
            this.failed(channelId); return;
          }
          const queued = this.pending.get(channelId)!;
          this.pending.delete(channelId);
          this.saved.set(channelId, BigInt(body.lastReadSequence));
          this.readError.set(null); this.revision.update(value => value + 1);
          if (queued > BigInt(body.lastReadSequence)) this.mark(channelId, queued.toString());
        },
        error: () => this.failed(channelId),
      });
  }

  private failed(channelId: string): void {
    this.pending.delete(channelId);
    this.readError.set({ channelId, message: 'Could not save your reading progress. It will retry while this conversation is visible.' });
  }
}
