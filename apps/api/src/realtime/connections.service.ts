import { Injectable, UnauthorizedException, type OnModuleDestroy } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { SessionService } from '../identity/session.service.js';
import { Subject } from 'rxjs';

type SessionConnections = { sockets: Set<Socket>; expiresAt: number; timer: ReturnType<typeof setTimeout> | undefined };

@Injectable()
export class ConnectionsService implements OnModuleDestroy {
  private readonly users = new Map<string, Set<Socket>>();
  private readonly sessions = new Map<string, SessionConnections>();
  private readonly channels = new Map<string, Promise<void>>();
  private readonly revocations;
  private readonly presence = new Subject<string>();
  readonly presenceChanges = this.presence.asObservable();

  constructor(private readonly identity: SessionService) {
    this.revocations = identity.revoked.subscribe(({ sessionId }) => this.endSession(sessionId));
  }

  async add(socket: Socket): Promise<void> {
    if (!socket.connected) return;
    const userId = socket.data.userId as string;
    const sessionId = socket.data.sessionId as string;
    const sockets = this.users.get(userId) ?? new Set<Socket>();
    sockets.add(socket);
    this.users.set(userId, sockets);
    const session = this.sessions.get(sessionId) ?? { sockets: new Set<Socket>(), expiresAt: socket.data.expiresAt as number, timer: undefined };
    session.sockets.add(socket);
    this.sessions.set(sessionId, session);
    socket.once('disconnect', () => {
      this.stopTyping(socket);
      sockets.delete(socket);
      if (!sockets.size) this.users.delete(userId);
      session.sockets.delete(socket);
      if (!session.sockets.size) { clearTimeout(session.timer); this.sessions.delete(sessionId); }
      if (socket.data.presenceReady) { delete socket.data.presenceReady; this.presence.next(userId); }
    });
    if (!session.timer) this.scheduleExpiry(sessionId, session);
    if (!socket.connected) return;
    // Index before rechecking: revocation before registration is caught by the read, after it by the event.
    try {
      const current = await this.identity.authenticate(socket.request.headers.cookie);
      if (current.id !== sessionId) this.endSession(sessionId);
      else if (socket.connected && Number(socket.data.expiresAt) > Date.now()) {
        socket.data.presenceReady = true;
        this.presence.next(userId);
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) this.endSession(sessionId);
      else socket.disconnect(true);
    }
  }

  private scheduleExpiry(sessionId: string, session: SessionConnections): void {
    const remaining = session.expiresAt - Date.now();
    if (remaining <= 0) { this.endSession(sessionId); return; }
    session.timer = setTimeout(() => this.scheduleExpiry(sessionId, session), Math.min(remaining, 2147483647));
    session.timer.unref();
  }

  private endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.timer);
    for (const socket of [...session.sockets]) {
      socket.emit('session:ended');
      socket.disconnect(true);
    }
  }

  onModuleDestroy(): void {
    this.presence.complete();
    this.revocations.unsubscribe();
    for (const session of this.sessions.values()) clearTimeout(session.timer);
    this.sessions.clear(); this.users.clear();
  }

  connectedSessionIds(userIds: string[]): string[] {
    const ids = new Set<string>();
    for (const userId of userIds) for (const socket of this.users.get(userId) ?? []) {
      if (this.present(socket)) ids.add(socket.data.sessionId as string);
    }
    return [...ids];
  }

  countConnections(userId: string, validSessionIds: ReadonlySet<string>): number {
    let count = 0;
    for (const socket of this.users.get(userId) ?? []) {
      if (this.present(socket) && validSessionIds.has(socket.data.sessionId as string)) count++;
    }
    return count;
  }

  private present(socket: Socket): boolean {
    return socket.connected && socket.data.presenceReady === true && Number(socket.data.expiresAt) > Date.now();
  }

  presenceChanged(userIds: string[]): void {
    for (const userId of userIds) for (const socket of this.users.get(userId) ?? []) {
      if (this.present(socket)) socket.emit('presence:changed');
    }
  }

  // shortcut: coordination and rooms are process-local; replace both before running multiple API instances.
  async withChannel<T>(channelId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.channels.get(channelId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.channels.set(channelId, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.channels.get(channelId) === current) this.channels.delete(channelId);
    }
  }

  subscribe(socket: Socket, channelId: string): void {
    if (!socket.connected) return;
    if (socket.data.channelId !== channelId) this.stopTyping(socket);
    // The installed in-memory adapter changes rooms synchronously, without network I/O.
    if (socket.data.channelId) void socket.leave(`channel:${socket.data.channelId}`);
    void socket.join(`channel:${channelId}`);
    socket.data.channelId = channelId;
  }

  unsubscribe(socket: Socket, channelId: string): void {
    if (socket.data.typingChannelId === channelId) this.stopTyping(socket);
    void socket.leave(`channel:${channelId}`);
    if (socket.data.channelId === channelId) delete socket.data.channelId;
  }

  stopTyping(socket: Socket): void {
    const channelId = socket.data.typingChannelId as string | undefined;
    delete socket.data.typingChannelId;
    if (!channelId) return;
    for (const id of socket.nsp.adapter.rooms.get(`channel:${channelId}`) ?? []) {
      const recipient = socket.nsp.sockets.get(id);
      if (recipient && recipient !== socket && recipient.connected && Number(recipient.data.expiresAt) > Date.now()
        && recipient.rooms.has(`channel:${channelId}`)) {
        recipient.volatile.emit('typing:changed', { channelId, connectionId: socket.id, user: null });
      }
    }
  }

  revokeChannel(userId: string, channelId: string): void {
    for (const socket of this.users.get(userId) ?? []) {
      this.unsubscribe(socket, channelId);
      socket.emit('channel:access-revoked', { channelId });
    }
  }

  activityChanged(userIds: string[]): void {
    for (const userId of userIds) for (const socket of this.users.get(userId) ?? []) {
      // Invalidation carries no channel data; the authenticated HTTP read remains authoritative.
      if (socket.connected && Number(socket.data.expiresAt) > Date.now()) socket.emit('activity:changed');
    }
  }
}
