import { DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { io } from 'socket.io-client';
import { isApiError } from '@real-time-chat/contracts';
import type { ChannelSubscriptionAck } from '@real-time-chat/contracts/channels';
import type { SendMessageAck, SendMessageRequest } from '@real-time-chat/contracts/messages';
import { SessionStore } from './session.store';

@Injectable()
export class RealtimeConnection {
  private readonly sessions = inject(SessionStore);
  private readonly socket = io({ path: '/socket.io', autoConnect: false, transports: ['polling', 'websocket'], timeout: 5000 });
  private readonly phase = signal<'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'unauthenticated' | 'disconnected' | 'rate-limited'>('disconnected');
  readonly status = this.phase.asReadonly();
  private subscriptions: Promise<unknown> = Promise.resolve();

  listen(event: 'message:created' | 'channel:access-revoked' | 'activity:changed', listener: (payload: unknown) => void): () => void {
    this.socket.on(event, listener);
    return () => { this.socket.off(event, listener); };
  }

  subscription(channelId: string, subscribed: boolean): Promise<ChannelSubscriptionAck> {
    const socketId = this.socket.id;
    // Different channels have separate server queues; serialize this socket's room changes.
    const operation = this.subscriptions.then(async () => {
      if (!this.socket.connected || this.socket.id !== socketId) throw new Error('Disconnected');
      try {
        return await this.socket.timeout(5000).emitWithAck(subscribed ? 'channel:subscribe' : 'channel:unsubscribe', { channelId }) as ChannelSubscriptionAck;
      } catch (error) {
        // An unknown room change must not overtake the next selection on this connection.
        if (this.socket.id === socketId) this.socket.disconnect();
        throw error;
      }
    });
    this.subscriptions = operation.catch(() => undefined);
    return operation;
  }

  send(input: SendMessageRequest): Promise<SendMessageAck> {
    if (!this.socket.connected) return Promise.reject(new Error('Disconnected'));
    // The store's 5s deadline permits one retry; retain late acks for a bounded 30s per attempt.
    return this.socket.timeout(30000).emitWithAck('message:send', input) as Promise<SendMessageAck>;
  }

  constructor() {
    this.socket.on('connect', () => this.phase.set('connected'));
    this.socket.on('session:ended', () => { this.phase.set('unauthenticated'); this.sessions.end(); });
    this.socket.on('disconnect', () => {
      if (this.phase() !== 'unauthenticated') this.phase.set(this.socket.active ? 'reconnecting' : 'disconnected');
    });
    this.socket.on('connect_error', (error: Error & { data?: unknown }) => {
      if (isApiError(error.data) && error.data.code === 'UNAUTHENTICATED') {
        this.phase.set('unauthenticated'); this.sessions.end();
      }
      else if (isApiError(error.data) && error.data.code === 'RATE_LIMITED') this.phase.set('rate-limited');
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
