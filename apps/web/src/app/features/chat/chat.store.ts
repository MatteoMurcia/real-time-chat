import { computed, DestroyRef, DOCUMENT, effect, inject, Injectable, signal } from '@angular/core';
import { isApiError } from '@real-time-chat/contracts';
import type { PublicMessage, SendMessageRequest } from '@real-time-chat/contracts/messages';
import { RealtimeConnection } from '../../core/realtime-connection';
import { SessionStore } from '../../core/session.store';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { HistoryClient } from './history-client';
import { SYNC_INTERVAL_MS, SyncService } from './sync.service';
import { isMessage } from './message';
import { reduceMessages, type MessageState, type Outgoing } from './message.reducer';

@Injectable()
export class ChatStore {
  private readonly connection = inject(RealtimeConnection);
  private readonly sessions = inject(SessionStore);
  private readonly history = inject(HistoryClient);
  private readonly sync = inject(SyncService);
  private readonly document = inject(DOCUMENT);
  private historyRequest?: Subscription;
  private syncRequest?: Subscription;
  private readonly channelId = signal<string | null>(null);
  private readonly subscribed = signal(false);
  private revision = 0;
  private viewRevision = 0;
  private readonly messageState = signal<MessageState>({ messages: [], outgoing: [] });
  private readonly deadlines = new Set<ReturnType<typeof setTimeout>>();
  readonly messages = computed(() => this.messageState().messages);
  readonly outgoing = computed(() => this.messageState().outgoing);
  readonly outgoingNotice = computed(() => {
    const items = this.outgoing();
    if (!items.length) return 'No messages awaiting confirmation.';
    const count = (state: Outgoing['state']) => items.filter(item => item.state === state).length;
    return `${count('pending')} sending, ${count('unconfirmed')} unconfirmed, ${count('rejected')} rejected.`;
  });
  readonly notice = signal('');
  readonly liveNotice = signal('');
  readonly historyLoading = signal(false);
  readonly historyError = signal('');
  readonly olderCursor = signal<string | null>(null);
  readonly snapshotCursor = signal<string | null>(null);
  readonly syncCursor = signal<string | null>(null);
  readonly syncLoading = signal(false);
  readonly syncError = signal('');
  readonly ready = computed(() => this.subscribed() && this.connection.status() === 'connected');

  constructor() {
    const recover = () => this.recover();
    const visibility = () => this.document.visibilityState === 'visible' ? this.recover() : this.stopSync();
    this.document.defaultView?.addEventListener('focus', recover);
    this.document.addEventListener('visibilitychange', visibility);
    const interval = setInterval(recover, inject(SYNC_INTERVAL_MS));
    const stopMessages = this.connection.listen('message:created', value => {
      if (isMessage(value) && value.channelId === this.channelId()) {
        const known = this.messages().some(message => message.id === value.id);
        this.confirm(value);
        if (!known) this.liveNotice.set(`Message ${value.sequence} received from ${value.author.displayName}.`);
      }
    });
    const stopRevocations = this.connection.listen('channel:access-revoked', value => {
      if (value && typeof value === 'object' && 'channelId' in value && value.channelId === this.channelId()) this.revoke();
    });
    effect(() => {
      const channelId = this.channelId();
      const connected = this.connection.status() === 'connected';
      const revision = ++this.revision;
      this.subscribed.set(false);
      if (!connected) {
        this.stopSync();
        this.updateMessages({ type: 'disconnect' });
        if (channelId) this.notice.set('Live updates paused. Missed messages will be recovered after reconnecting.');
      }
      if (!channelId || !connected) return;
      this.notice.set('Opening live conversation…');
      void this.connection.subscription(channelId, true).then(ack => {
        if (revision !== this.revision) return;
        if (ack?.ok === true && ack.data?.channelId === channelId && ack.data.subscribed === true) {
          this.subscribed.set(true);
          this.notice.set('Live conversation ready.');
          if (!this.snapshotCursor()) this.loadHistory();
          else this.recover();
        } else if (ack?.ok === false && isApiError(ack.error) && ['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND'].includes(ack.error.code)) this.revoke();
        else this.notice.set('Could not open the conversation. Close it and try again.');
      }).catch(() => {
        if (revision === this.revision) this.notice.set('Could not confirm the subscription. Retry the connection.');
      });
    });
    inject(DestroyRef).onDestroy(() => {
      clearInterval(interval);
      this.document.defaultView?.removeEventListener('focus', recover);
      this.document.removeEventListener('visibilitychange', visibility);
      stopMessages(); stopRevocations(); this.open(null);
    });
  }

  open(channelId: string | null): void {
    const previous = this.channelId();
    if (previous === channelId) return;
    ++this.revision;
    this.resetContent();
    this.subscribed.set(false);
    this.channelId.set(channelId);
    this.notice.set('');
    if (previous) void this.connection.subscription(previous, false).catch(() => undefined);
  }

  private resetContent(): void {
    ++this.viewRevision;
    this.stopSync(); this.syncCursor.set(null); this.syncError.set('');
    for (const deadline of this.deadlines) clearTimeout(deadline);
    this.deadlines.clear();
    this.historyRequest?.unsubscribe();
    this.historyLoading.set(false); this.historyError.set('');
    this.olderCursor.set(null); this.snapshotCursor.set(null);
    this.messageState.set({ messages: [], outgoing: [] }); this.liveNotice.set('');
  }

  loadHistory(recover = true): void {
    const channelId = this.channelId(), before = this.olderCursor(), revision = this.viewRevision;
    if (!channelId || !this.ready() || this.historyLoading() || (this.snapshotCursor() && !before)) return;
    this.historyLoading.set(true); this.historyError.set('');
    this.historyRequest = this.history.list(channelId, before).subscribe({
      next: page => {
        if (revision !== this.viewRevision) return;
        if (this.snapshotCursor() && page.snapshotCursor !== this.snapshotCursor()) {
          this.historyLoading.set(false); this.historyError.set('History could not be loaded. Try again.'); return;
        }
        for (const message of page.items) this.confirm(message);
        this.snapshotCursor.set(page.snapshotCursor); this.olderCursor.set(page.olderCursor);
        this.historyLoading.set(false);
        if (this.syncCursor() === null) {
          this.syncCursor.set(page.snapshotCursor);
          if (recover) this.recover();
        }
      },
      error: (error: unknown) => {
        if (revision !== this.viewRevision) return;
        this.historyLoading.set(false);
        if (error instanceof HttpErrorResponse && [401, 403, 404].includes(error.status)) this.revoke();
        else this.historyError.set('History could not be loaded. Try again.');
      },
    });
  }

  recover(): void {
    const channelId = this.channelId(), after = this.syncCursor(), revision = this.viewRevision;
    if (!channelId || !this.ready() || this.document.visibilityState !== 'visible' || this.syncLoading()) return;
    if (after === null) { this.loadHistory(); return; }
    let recovered = 0, lastRecoveredSequence = '';
    const announce = () => {
      if (recovered) this.liveNotice.set(`Conversation updated. ${recovered} new messages loaded through message ${lastRecoveredSequence}.`);
    };
    this.syncLoading.set(true); this.syncError.set('');
    this.syncRequest = this.sync.recover(channelId, after).subscribe({
      next: page => {
        if (revision !== this.viewRevision) return;
        const count = this.messages().length;
        for (const message of page.items) this.confirm(message);
        this.syncCursor.set(page.nextCursor);
        const added = this.messages().length - count;
        if (added) { recovered += added; lastRecoveredSequence = page.items.at(-1)!.sequence; }
      },
      error: (error: unknown) => {
        if (revision !== this.viewRevision) return;
        this.syncLoading.set(false);
        if (error instanceof HttpErrorResponse && [401, 403, 404].includes(error.status)) this.revoke();
        else if (error instanceof HttpErrorResponse && error.status === 400) {
          this.resetContent(); this.loadHistory(false);
        } else {
          announce(); this.syncError.set('Could not recover missed messages. Your loaded messages are kept. Try again.');
        }
      },
      complete: () => { if (revision === this.viewRevision) { this.syncLoading.set(false); announce(); } },
    });
  }

  private stopSync(): void {
    this.syncRequest?.unsubscribe(); this.syncLoading.set(false);
  }

  send(body: string): boolean {
    if (!this.ready()) return false;
    if (!body.trim() || [...body].length > 2000 || body.includes('\0') || /[\uD800-\uDFFF]/u.test(body)) {
      this.notice.set('Write 1–2,000 characters of valid text.'); return false;
    }
    const request = { channelId: this.channelId()!, clientMessageId: crypto.randomUUID(), body };
    this.updateMessages({ type: 'queue', request });
    void this.deliver(request, 1);
    return true;
  }

  retry(item: Outgoing): void {
    const current = this.outgoing().find(value => value.request === item.request);
    if (!this.ready() || current?.state !== 'unconfirmed') return;
    this.updateMessages({ type: 'retry', request: current.request });
    void this.deliver(current.request, current.attempt + 1);
  }

  private async deliver(request: SendMessageRequest, attempt: number): Promise<void> {
    const revision = this.viewRevision;
    const current = () => revision === this.viewRevision && this.outgoing().some(item => item.request === request && item.attempt === attempt);
    const deadline = setTimeout(() => {
      this.deadlines.delete(deadline);
      if (!current()) return;
      this.updateMessages({ type: 'unconfirmed', request, attempt });
      const item = this.outgoing().find(value => value.request === request);
      if (attempt === 1 && item) this.retry(item);
    }, 5000);
    this.deadlines.add(deadline);
    try {
      const ack = await this.connection.send(request);
      if (revision !== this.viewRevision) return;
      if (ack?.ok === true && isMessage(ack.data) && ack.data.channelId === request.channelId
        && ack.data.clientMessageId === request.clientMessageId && ack.data.body === request.body
        && ack.data.author.id === this.sessions.session()?.user.id) this.confirm(ack.data);
      else if (!current()) return;
      else if (ack?.ok === false && isApiError(ack.error)) {
        if (['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND'].includes(ack.error.code)) this.revoke();
        else this.updateMessages({ type: ['VALIDATION_ERROR', 'CONFLICT'].includes(ack.error.code) ? 'rejected' : 'unconfirmed', request, attempt });
      } else this.updateMessages({ type: 'unconfirmed', request, attempt });
    } catch { if (current()) this.updateMessages({ type: 'unconfirmed', request, attempt }); }
    finally { clearTimeout(deadline); this.deadlines.delete(deadline); }
  }

  private confirm(message: PublicMessage): void {
    if (message.channelId !== this.channelId()) return;
    this.updateMessages({ type: 'confirm', message, userId: this.sessions.session()?.user.id });
  }

  private updateMessages(action: Parameters<typeof reduceMessages>[1]): void {
    this.messageState.update(state => reduceMessages(state, action));
  }

  private revoke(): void {
    this.open(null);
    this.notice.set('Access to this conversation ended. Refresh channels or sign in again.');
  }
}
