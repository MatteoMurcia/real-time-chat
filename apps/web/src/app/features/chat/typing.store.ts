import { computed, DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { TYPING_INTERVAL_MS, TYPING_TTL_MS, type TypingChanged } from '@real-time-chat/contracts/activity';
import { RealtimeConnection } from '../../core/realtime-connection';
import { SessionStore } from '../../core/session.store';
import { ActivityService } from '../../core/activity.service';

function isTypingChanged(value: unknown): value is TypingChanged {
  if (!value || typeof value !== 'object' || !('channelId' in value) || typeof value.channelId !== 'string'
    || !('connectionId' in value) || typeof value.connectionId !== 'string' || !value.connectionId
    || value.connectionId.length > 128 || !('user' in value)) return false;
  const user = value.user;
  return user === null || (!!user && typeof user === 'object' && 'id' in user && typeof user.id === 'string'
    && !!user.id && 'displayName' in user && typeof user.displayName === 'string' && !!user.displayName && user.displayName.length <= 160);
}

@Injectable()
export class TypingStore {
  private readonly connection = inject(RealtimeConnection);
  private readonly sessions = inject(SessionStore);
  private readonly activity = inject(ActivityService);
  private channelId: string | null = null;
  private ready = false;
  private lastSent = -Infinity;
  private active = false;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly writers = signal(new Map<string, { user: NonNullable<TypingChanged['user']>; timer: ReturnType<typeof setTimeout> }>());
  readonly notice = computed(() => {
    const users = [...new Map([...this.writers().values()].map(writer => [writer.user.id, writer.user.displayName])).values()];
    if (!users.length) return '';
    const names = users.slice(0, 3).join(', ') + (users.length > 3 ? ` and ${users.length - 3} others` : '');
    return `${names} ${users.length === 1 ? 'is' : 'are'} typing…`;
  });

  constructor() {
    const stopListening = this.connection.listen('typing:changed', value => this.receive(value));
    effect(() => {
      const connected = this.connection.status() === 'connected', visible = this.activity.visible();
      if (!connected || !visible) untracked(() => this.clear());
    });
    inject(DestroyRef).onDestroy(() => { this.clear(); stopListening(); });
  }

  open(channelId: string, ready: boolean): void {
    if (channelId !== this.channelId || !ready) this.clear();
    this.channelId = channelId; this.ready = ready;
  }

  input(text: string): void {
    if (!text.trim()) { this.stop(); return; }
    if (!this.available()) return;
    if (Date.now() - this.lastSent >= TYPING_INTERVAL_MS) {
      this.connection.typing({ channelId: this.channelId!, typing: true });
      this.active = true; this.lastSent = Date.now();
    }
    clearTimeout(this.idle); this.idle = setTimeout(() => this.stop(), TYPING_TTL_MS);
  }

  stop(): void {
    clearTimeout(this.idle);
    if (this.active && this.channelId) this.connection.typing({ channelId: this.channelId, typing: false });
    this.active = false; this.lastSent = -Infinity;
  }

  private available(): boolean {
    return !!this.channelId && this.ready && this.connection.status() === 'connected' && this.activity.visible();
  }

  private receive(value: unknown): void {
    if (!this.available() || !isTypingChanged(value) || value.channelId !== this.channelId) return;
    const { connectionId, user } = value;
    if (user?.id === this.sessions.session()?.user.id) return;
    const writers = new Map(this.writers());
    clearTimeout(writers.get(connectionId)?.timer); writers.delete(connectionId);
    if (user && writers.size < 100) {
      const timer = setTimeout(() => {
        const current = new Map(this.writers()); current.delete(connectionId); this.writers.set(current);
      }, TYPING_TTL_MS);
      writers.set(connectionId, { user: { id: user.id, displayName: user.displayName }, timer });
    }
    this.writers.set(writers);
  }

  private clear(): void {
    this.stop();
    for (const writer of this.writers().values()) clearTimeout(writer.timer);
    this.writers.set(new Map());
  }
}
