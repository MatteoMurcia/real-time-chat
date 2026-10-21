import { HttpException, UnauthorizedException, type OnModuleDestroy } from '@nestjs/common';
import type { Socket } from 'socket.io';
import type { TrafficLimits } from '../config.js';

const windows = { send: 10000, typing: 10000, presence: 10000, login: 60000, register: 3600000, createChannel: 3600000 };
type Action = keyof typeof windows;
type Bucket = { attempts: number[]; window: number };

export class RateLimitService implements OnModuleDestroy {
  private readonly buckets = new Map<string, Bucket>();
  private readonly connections = new Map<string, Set<Socket>>();
  private readonly cleanup = setInterval(() => this.sweep(), 60000).unref();
  constructor(private readonly limits: TrafficLimits) {}

  // shortcut: quotas reset on process restart; use a shared store before adding API instances.
  consume(action: Action, identity: string): void {
    const now = Date.now(), key = `${action}:${identity}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 10000) { this.sweep(); if (this.buckets.size >= 10000) throw new HttpException('Too many requests.', 429); }
      bucket = { attempts: [], window: windows[action] };
      this.buckets.set(key, bucket);
    }
    bucket.attempts = bucket.attempts.filter(time => time > now - bucket.window);
    if (bucket.attempts.length >= this.limits[action]) throw new HttpException('Too many requests.', 429);
    bucket.attempts.push(now);
  }

  reserveConnection(socket: Socket): void {
    if (socket.conn.readyState !== 'open') throw new UnauthorizedException();
    const sessionId = socket.data.sessionId as string;
    const sockets = this.connections.get(sessionId) ?? new Set<Socket>();
    if (sockets.size >= this.limits.connections || (!sockets.size && this.connections.size >= 10000)) throw new HttpException('Too many connections.', 429);
    sockets.add(socket); this.connections.set(sessionId, sockets);
    const release = () => {
      socket.off('disconnect', release); socket.conn.off('close', release);
      sockets.delete(socket);
      if (!sockets.size) this.connections.delete(sessionId);
    };
    // Namespace disconnect does not fire when a handshake is aborted; Engine close does.
    socket.once('disconnect', release); socket.conn.once('close', release);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) if (bucket.attempts.at(-1)! <= now - bucket.window) this.buckets.delete(key);
  }

  onModuleDestroy(): void { clearInterval(this.cleanup); this.buckets.clear(); this.connections.clear(); }
}
