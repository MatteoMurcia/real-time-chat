import { DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { io } from 'socket.io-client';
import { isApiError } from '@real-time-chat/contracts';
import { SessionStore } from './session.store';

@Injectable()
export class RealtimeConnection {
  private readonly sessions = inject(SessionStore);
  private readonly socket = io({ path: '/socket.io', autoConnect: false, transports: ['polling', 'websocket'], timeout: 5000 });
  private readonly phase = signal<'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'unauthenticated' | 'disconnected'>('disconnected');
  readonly status = this.phase.asReadonly();

  constructor() {
    this.socket.on('connect', () => this.phase.set('connected'));
    this.socket.on('disconnect', () => this.phase.set(this.socket.active ? 'reconnecting' : 'disconnected'));
    this.socket.on('connect_error', (error: Error & { data?: unknown }) => {
      if (isApiError(error.data) && error.data.code === 'UNAUTHENTICATED') this.phase.set('unauthenticated');
      else this.phase.set(this.socket.active ? 'reconnecting' : 'unavailable');
    });
    effect(onCleanup => {
      if (!this.sessions.session()) return;
      this.connect();
      onCleanup(() => this.socket.disconnect());
    });
    inject(DestroyRef).onDestroy(() => { this.socket.removeAllListeners(); this.socket.disconnect(); });
  }

  connect(): void {
    if (!this.sessions.session()) return;
    this.phase.set('connecting');
    this.socket.connect();
  }
}
