import { BadRequestException, Inject, UnauthorizedException } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer, type OnGatewayConnection, type OnGatewayInit } from '@nestjs/websockets';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server, Socket } from 'socket.io';
import type { ApiError } from '@real-time-chat/contracts';
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

@WebSocketGateway({ path: '/socket.io', serveClient: false, maxHttpBufferSize: 16384, transports: ['polling', 'websocket'] })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer() server!: Server;
  constructor(private readonly sessions: SessionService, @Inject('APP_ORIGIN') private readonly origin: string,
    private readonly db: DatabaseService, private readonly access: ChannelAccessService, private readonly connections: ConnectionsService,
    private readonly messages: SendMessageService) {}

  handleConnection(socket: Socket): Promise<void> { return this.connections.add(socket); }

  @SubscribeMessage('message:send')
  async send(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<SendMessageAck> {
    try {
      const input = validateMessage(body);
      return await this.connections.withChannel(input.channelId, async () => {
        const session = await this.sessions.authenticate(socket.request.headers.cookie);
        if (!socket.connected || session.id !== socket.data.sessionId) throw new UnauthorizedException();
        const { message, created } = await this.messages.send(session.user.id, input);
        if (created) await this.publish(message);
        return { ok: true, data: message };
      });
    } catch (error: unknown) { return { ok: false, error: socketError(error) }; }
  }

  private async publish(message: PublicMessage): Promise<void> {
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
    try {
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
    }
  }

  afterInit(server: Server): void {
    // Engine middleware covers polling requests and WebSocket upgrades, not only namespace connection.
    server.engine.use((request: IncomingMessage, _response: ServerResponse, next: (error?: Error) => void) => {
      try { verifyOrigin(request.headers, this.origin); next(); }
      catch { next(new Error('Forbidden')); }
    });
    server.use(async (socket, next) => {
      try {
        const session = await this.sessions.authenticate(socket.request.headers.cookie);
        socket.data.sessionId = session.id;
        socket.data.userId = session.user.id;
        socket.data.expiresAt = session.expiresAt.getTime();
        next();
      } catch (error: unknown) {
        const unauthenticated = error instanceof UnauthorizedException;
        const data: ApiError = {
          code: unauthenticated ? 'UNAUTHENTICATED' : 'INTERNAL_ERROR',
          message: unauthenticated ? 'Authentication is required.' : 'Connection could not be established.',
          requestId: randomUUID(),
        };
        next(Object.assign(new Error(data.message), { data }));
      }
    });
  }
}
