import { BadRequestException, Inject, UnauthorizedException } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer, type OnGatewayConnection, type OnGatewayInit } from '@nestjs/websockets';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server, Socket } from 'socket.io';
import type { ChannelSubscriptionAck } from '@real-time-chat/contracts/channels';
import { SessionService } from '../identity/session.service.js';
import { verifyOrigin } from '../identity/request-origin.js';
import { ChannelAccessService, validateChannelId } from '../channels/channel-access.service.js';
import { DatabaseService } from '../database/database.service.js';
import { ConnectionsService } from './connections.service.js';
import { SendMessageService } from '../messaging/send-message.service.js';
import { validateMessage } from '../messaging/validate-message.js';
import type { PublicMessage, SendMessageAck } from '@real-time-chat/contracts/messages';
import { socketError } from './socket-error.js';
import { RateLimitService } from '../security/rate-limit.service.js';
import { randomUUID } from 'node:crypto';
import { diagnostic, type Diagnostic } from '../logging/logger.js';
import { ShutdownError, ShutdownState } from '../shutdown/shutdown-state.js';

@WebSocketGateway({ path: '/socket.io', serveClient: false, maxHttpBufferSize: 16384, transports: ['polling', 'websocket'] })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer() server!: Server;
  constructor(private readonly sessions: SessionService, @Inject('APP_ORIGIN') private readonly origin: string,
    private readonly db: DatabaseService, private readonly access: ChannelAccessService, private readonly connections: ConnectionsService,
    private readonly messages: SendMessageService, private readonly limits: RateLimitService, private readonly shutdown: ShutdownState) {}

  async handleConnection(socket: Socket): Promise<void> {
    let release = () => {};
    try { release = this.shutdown.enter(); await this.connections.add(socket); }
    catch { socket.conn.close(); }
    finally { release(); }
  }

  @SubscribeMessage('message:send')
  async send(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<SendMessageAck> {
    const started = performance.now(), requestId = randomUUID();
    const candidate = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const ids = {
      ...(typeof candidate.clientMessageId === 'string' ? { clientMessageId: candidate.clientMessageId } : {}),
      ...(typeof candidate.channelId === 'string' ? { channelId: candidate.channelId } : {}),
    };
    let stage: Diagnostic['stage'] = 'authorize';
    let release = () => {};
    try {
      release = this.shutdown.enter();
      if (!socket.connected || typeof socket.data.userId !== 'string') throw new UnauthorizedException();
      this.limits.consume('send', socket.data.userId);
      const input = validateMessage(body);
      return await this.connections.withChannel(input.channelId, async () => {
        const session = await this.sessions.authenticate(socket.request.headers.cookie);
        if (!socket.connected || session.id !== socket.data.sessionId) throw new UnauthorizedException();
        stage = 'persist';
        const { message, created } = await this.messages.send(session.user.id, input);
        stage = 'publish';
        if (created) await this.publish(message);
        diagnostic({ event: 'message.send', requestId, ...ids, outcome: created ? 'created' : 'duplicate', durationMs: Math.round(performance.now() - started) });
        return { ok: true, data: message };
      });
    } catch (error: unknown) { return { ok: false, error: socketError(error, { ...ids, stage, durationMs: Math.round(performance.now() - started) }, requestId) }; }
    finally { release(); }
  }

  private async publish(message: PublicMessage): Promise<void> {
    const members = await this.db.membership.findMany({ where: { channelId: message.channelId }, select: { userId: true } });
    this.connections.activityChanged(members.map(member => member.userId));
    const namespace = this.server.of('/');
    const sockets = [...(namespace.adapter.rooms.get(`channel:${message.channelId}`) ?? [])]
      .map(id => namespace.sockets.get(id)).filter((socket): socket is Socket => !!socket);
    if (!sockets.length) return;
    const sessions = await this.db.session.findMany({
      where: { id: { in: [...new Set(sockets.map(socket => socket.data.sessionId as string))] }, expiresAt: { gt: new Date() } },
      select: { id: true, expiresAt: true },
    });
    const valid = new Set(sessions.filter(session => session.expiresAt.getTime() > Date.now()).map(session => session.id));
    for (const socket of sockets) if (socket.connected && socket.rooms.has(`channel:${message.channelId}`)
      && valid.has(socket.data.sessionId as string)) socket.emit('message:created', message);
  }

  @SubscribeMessage('channel:subscribe')
  subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<ChannelSubscriptionAck> {
    return this.subscription(socket, body, true);
  }

  @SubscribeMessage('channel:unsubscribe')
  unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<ChannelSubscriptionAck> {
    return this.subscription(socket, body, false);
  }

  private async subscription(socket: Socket, body: unknown, subscribed: boolean): Promise<ChannelSubscriptionAck> {
    let release = () => {};
    try {
      release = this.shutdown.enter();
      if (!body || typeof body !== 'object' || Array.isArray(body) || !('channelId' in body)
        || typeof body.channelId !== 'string' || Object.keys(body).length !== 1) throw new BadRequestException();
      const channelId = validateChannelId(body.channelId);
      return await this.connections.withChannel(channelId, async () => {
        const session = await this.sessions.authenticate(socket.request.headers.cookie);
        if (!socket.connected || session.id !== socket.data.sessionId) throw new UnauthorizedException();
        if (subscribed) {
          await this.db.$transaction(async tx => {
            await this.access.lockChannel(tx, channelId);
            await this.access.requireMember(session.user.id, channelId, tx);
          });
          this.connections.subscribe(socket, channelId);
        } else this.connections.unsubscribe(socket, channelId);
        return { ok: true, data: { channelId, subscribed } };
      });
    } catch (error: unknown) {
      return { ok: false, error: socketError(error) };
    } finally { release(); }
  }

  afterInit(server: Server): void {
    // Engine middleware covers polling requests and WebSocket upgrades, not only namespace connection.
    server.engine.use((request: IncomingMessage, _response: ServerResponse, next: (error?: Error) => void) => {
      try {
        verifyOrigin(request.headers, this.origin);
        if (this.shutdown.draining && !new URL(request.url ?? '/', this.origin).searchParams.get('sid')) throw new ShutdownError();
        next();
      } catch (error) { next(new Error(error instanceof ShutdownError ? 'Server shutting down' : 'Forbidden')); }
    });
    server.use(async (socket, next) => {
      let release = () => {};
      try {
        release = this.shutdown.enter();
        const session = await this.sessions.authenticate(socket.request.headers.cookie);
        if (this.shutdown.draining) throw new ShutdownError();
        socket.data.sessionId = session.id;
        socket.data.userId = session.user.id;
        socket.data.expiresAt = session.expiresAt.getTime();
        this.limits.reserveConnection(socket);
        next();
      } catch (error: unknown) {
        if (error instanceof ShutdownError) { socket.conn.close(); return; }
        const data = socketError(error);
        next(Object.assign(new Error(data.message), { data }));
      } finally { release(); }
    });
  }
}
