import { Injectable } from '@nestjs/common';
import type { Socket } from 'socket.io';

@Injectable()
export class ConnectionsService {
  private readonly users = new Map<string, Set<Socket>>();
  private readonly channels = new Map<string, Promise<void>>();

  add(socket: Socket): void {
    const userId = socket.data.userId as string;
    const sockets = this.users.get(userId) ?? new Set<Socket>();
    sockets.add(socket);
    this.users.set(userId, sockets);
    socket.once('disconnect', () => {
      sockets.delete(socket);
      if (!sockets.size) this.users.delete(userId);
    });
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
