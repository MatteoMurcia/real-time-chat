import { Injectable, UnauthorizedException, type OnModuleDestroy } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { SessionService } from '../identity/session.service.js';

type SessionConnections = { sockets: Set<Socket>; expiresAt: number; timer: ReturnType<typeof setTimeout> | undefined };

@Injectable()
export class ConnectionsService implements OnModuleDestroy {
  private readonly users = new Map<string, Set<Socket>>();
  private readonly sessions = new Map<string, SessionConnections>();
  private readonly channels = new Map<string, Promise<void>>();
  private readonly revocations;

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
      sockets.delete(socket);
      if (!sockets.size) this.users.delete(userId);
      session.sockets.delete(socket);
      if (!session.sockets.size) { clearTimeout(session.timer); this.sessions.delete(sessionId); }
    });
    if (!session.timer) this.scheduleExpiry(sessionId, session);
    if (!socket.connected) return;
    // Index before rechecking: revocation before registration is caught by the read, after it by the event.
    try {
      const current = await this.identity.authenticate(socket.request.headers.cookie);
      if (current.id !== sessionId) this.endSession(sessionId);
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
    this.revocations.unsubscribe();
    for (const session of this.sessions.values()) clearTimeout(session.timer);
    this.sessions.clear(); this.users.clear();
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
    // The installed in-memory adapter changes rooms synchronously, without network I/O.
    if (socket.data.channelId) void socket.leave(`channel:${socket.data.channelId}`);
    void socket.join(`channel:${channelId}`);
    socket.data.channelId = channelId;
  }

  unsubscribe(socket: Socket, channelId: string): void {
    void socket.leave(`channel:${channelId}`);
    if (socket.data.channelId === channelId) delete socket.data.channelId;
  }

  revokeChannel(userId: string, channelId: string): void {
    for (const socket of this.users.get(userId) ?? []) {
      this.unsubscribe(socket, channelId);
      socket.emit('channel:access-revoked', { channelId });
    }
  }
}
