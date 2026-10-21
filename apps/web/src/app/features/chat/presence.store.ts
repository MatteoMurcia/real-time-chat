import { DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { ActivityService } from '../../core/activity.service';
import { RealtimeConnection } from '../../core/realtime-connection';

function snapshot(value: unknown, channelId: string, ids: string[]): Map<string, boolean> | null {
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true || !('data' in value)
    || !value.data || typeof value.data !== 'object' || !('channelId' in value.data) || value.data.channelId !== channelId
    || !('users' in value.data) || !Array.isArray(value.data.users) || value.data.users.length > ids.length) return null;
  const result = new Map<string, boolean>();
  for (const user of value.data.users) {
    if (!user || typeof user !== 'object' || !('userId' in user) || typeof user.userId !== 'string' || !ids.includes(user.userId)
      || result.has(user.userId) || !('online' in user) || typeof user.online !== 'boolean') return null;
    result.set(user.userId, user.online);
  }
  return result;
}

@Injectable()
export class PresenceStore {
  private readonly connection = inject(RealtimeConnection);
  private readonly activity = inject(ActivityService);
  private readonly states = signal(new Map<string, boolean>());
  readonly notice = signal('');
  private channelId = '';
  private ids: string[] = [];
  private ready = false;
  private generation = 0;
  private busy = false;
  private dirty = false;
  private destroyed = false;
  private nextAttempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const stop = this.connection.listen('presence:changed', () => this.refresh());
    effect(() => {
      const connected = this.connection.status() === 'connected', visible = this.activity.visible();
      this.activity.revision();
      untracked(() => {
        if (!connected || !visible) this.clear();
        else this.refresh();
      });
    });
    inject(DestroyRef).onDestroy(() => { this.destroyed = true; this.clear(); stop(); });
  }

  select(channelId: string, ready: boolean, userIds: string[]): void {
    const ids = [...new Set(userIds.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      .map(id => id.toLowerCase()).reverse())].slice(0, 100).sort();
    if (channelId === this.channelId && ready === this.ready && ids.join() === this.ids.join()) return;
    if (channelId !== this.channelId || !ready) this.clear();
    else {
      ++this.generation;
      this.states.update(states => new Map([...states].filter(([id]) => ids.includes(id))));
    }
    this.channelId = channelId; this.ids = ids; this.ready = ready;
    if (!ids.length) this.notice.set('');
    else if (!this.states().size) this.notice.set('Presence unknown.');
    this.refresh();
  }

  label(userId: string): string {
    const state = this.available() ? this.states().get(userId.toLowerCase()) : undefined;
    return state === true ? 'Online' : state === false ? 'Offline' : 'Presence unknown';
  }

  private available(): boolean {
    return !this.destroyed && this.ready && !!this.ids.length && this.connection.status() === 'connected' && this.activity.visible();
  }

  private refresh(): void {
    if (!this.available()) return;
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.busy || this.timer !== undefined || !this.available()) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.query(); }, Math.max(0, this.nextAttempt - Date.now()));
  }

  private async query(): Promise<void> {
    if (!this.available()) return;
    const generation = this.generation, channelId = this.channelId, ids = this.ids;
    this.busy = true; this.dirty = false; this.nextAttempt = Date.now() + 2000;
    try {
      const response = await this.connection.presence({ channelId, userIds: ids });
      if (generation !== this.generation || !this.available()) return;
      const states = snapshot(response, channelId, ids);
      if (!states) throw new Error('Invalid presence response');
      if (!this.dirty) { this.states.set(states); this.notice.set(''); }
    } catch {
      if (generation !== this.generation || !this.available()) return;
      this.states.set(new Map()); this.notice.set('Presence is temporarily unavailable.');
      this.nextAttempt = Date.now() + 10000; this.dirty = true;
    } finally {
      this.busy = false;
      if (this.dirty) this.schedule();
    }
  }

  private clear(): void {
    ++this.generation; this.dirty = false;
    clearTimeout(this.timer); this.timer = undefined;
    this.states.set(new Map()); this.notice.set(this.ids.length ? 'Presence unknown.' : '');
  }
}
