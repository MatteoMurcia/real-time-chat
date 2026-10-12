import { computed, DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { isApiError } from '@real-time-chat/contracts';
import type { PublicMessage, SendMessageRequest } from '@real-time-chat/contracts/messages';
import { RealtimeConnection } from '../../core/realtime-connection';
import { SessionStore } from '../../core/session.store';

interface Outgoing { request: SendMessageRequest; state: 'pending' | 'unconfirmed' | 'rejected' }

function isMessage(value: unknown): value is PublicMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<PublicMessage>;
  return typeof message.id === 'string' && typeof message.channelId === 'string'
    && typeof message.clientMessageId === 'string' && typeof message.sequence === 'string'
    && /^[1-9]\d{0,18}$/.test(message.sequence) && typeof message.body === 'string'
    && [...message.body].length <= 2000 && !!message.body.trim()
    && typeof message.author?.id === 'string' && typeof message.author.displayName === 'string'
    && typeof message.createdAt === 'string' && Number.isFinite(Date.parse(message.createdAt));
}

@Injectable()
export class ChatStore {
  private readonly connection = inject(RealtimeConnection);
  private readonly sessions = inject(SessionStore);
  private readonly channelId = signal<string | null>(null);
  private readonly subscribed = signal(false);
  private revision = 0;
  private viewRevision = 0;
  readonly messages = signal<PublicMessage[]>([]);
  readonly outgoing = signal<Outgoing[]>([]);
  readonly notice = signal('');
  readonly ready = computed(() => this.subscribed() && this.connection.status() === 'connected');

  constructor() {
    const stopMessages = this.connection.listen('message:created', value => { if (isMessage(value)) this.confirm(value); });
    const stopRevocations = this.connection.listen('channel:access-revoked', value => {
      if (value && typeof value === 'object' && 'channelId' in value && value.channelId === this.channelId()) this.revoke();
    });
    effect(() => {
      const channelId = this.channelId();
      const connected = this.connection.status() === 'connected';
      const revision = ++this.revision;
      this.subscribed.set(false);
      if (!connected) {
        this.outgoing.update(items => items.map(item => item.state === 'pending' ? { ...item, state: 'unconfirmed' } : item));
        if (channelId) this.notice.set('Live updates paused. Reconnecting does not recover missed messages yet.');
      }
      if (!channelId || !connected) return;
      this.notice.set('Opening live conversation…');
      void this.connection.subscription(channelId, true).then(ack => {
        if (revision !== this.revision) return;
        if (ack?.ok === true && ack.data?.channelId === channelId && ack.data.subscribed === true) {
          this.subscribed.set(true);
          this.notice.set('Live conversation ready. Only messages received while this view is open are shown.');
        } else if (ack?.ok === false && isApiError(ack.error) && ['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND'].includes(ack.error.code)) this.revoke();
        else this.notice.set('Could not open the conversation. Close it and try again.');
      }).catch(() => {
        if (revision === this.revision) this.notice.set('Could not confirm the subscription. Retry the connection.');
      });
    });
    inject(DestroyRef).onDestroy(() => {
      stopMessages(); stopRevocations(); this.open(null);
    });
  }

  open(channelId: string | null): void {
    const previous = this.channelId();
    if (previous === channelId) return;
    ++this.revision;
    ++this.viewRevision;
    this.subscribed.set(false);
    this.channelId.set(channelId);
    this.messages.set([]); this.outgoing.set([]); this.notice.set('');
    if (previous) void this.connection.subscription(previous, false).catch(() => undefined);
  }

  send(body: string): boolean {
    if (!this.ready()) return false;
    if (!body.trim() || [...body].length > 2000 || body.includes('\0') || /[\uD800-\uDFFF]/u.test(body)) {
      this.notice.set('Write 1–2,000 characters of valid text.'); return false;
    }
    const request = { channelId: this.channelId()!, clientMessageId: crypto.randomUUID(), body };
    this.outgoing.update(items => [...items, { request, state: 'pending' }]);
    void this.deliver(request);
    return true;
  }

  retry(item: Outgoing): void {
    if (!this.ready() || item.state !== 'unconfirmed') return;
    this.setState(item.request, 'pending');
    void this.deliver(item.request);
  }

  private async deliver(request: SendMessageRequest): Promise<void> {
    const revision = this.viewRevision;
    try {
      const ack = await this.connection.send(request);
      if (revision !== this.viewRevision) return;
      if (ack?.ok === true && isMessage(ack.data) && ack.data.channelId === request.channelId
        && ack.data.clientMessageId === request.clientMessageId && ack.data.body === request.body
        && ack.data.author.id === this.sessions.session()?.user.id) this.confirm(ack.data);
      else if (ack?.ok === false && isApiError(ack.error)) {
        if (['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND'].includes(ack.error.code)) this.revoke();
        else this.setState(request, ['VALIDATION_ERROR', 'CONFLICT', 'RATE_LIMITED'].includes(ack.error.code) ? 'rejected' : 'unconfirmed');
      } else this.setState(request, 'unconfirmed');
    } catch { if (revision === this.viewRevision) this.setState(request, 'unconfirmed'); }
  }

  private confirm(message: PublicMessage): void {
    if (message.channelId !== this.channelId()) return;
    this.messages.update(items => {
      if (items.some(item => item.id === message.id)) return items;
      // shortcut: keep the latest 100 live messages; paginated history arrives in 2.4a.
      return [...items, message].sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1).slice(-100);
    });
    if (message.author.id === this.sessions.session()?.user.id) {
      this.outgoing.update(items => items.filter(item => item.request.clientMessageId !== message.clientMessageId));
    }
  }

  private setState(request: SendMessageRequest, state: Outgoing['state']): void {
    this.outgoing.update(items => items.map(item => item.request === request ? { ...item, state } : item));
  }

  private revoke(): void {
    this.open(null);
    this.notice.set('Access to this conversation ended. Refresh channels or sign in again.');
  }
}
