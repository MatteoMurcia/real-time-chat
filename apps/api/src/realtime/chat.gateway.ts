import { BadRequestException, HttpException, Inject, UnauthorizedException } from '@nestjs/common';
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

@WebSocketGateway({ path: '/socket.io', serveClient: false, maxHttpBufferSize: 8192, transports: ['polling', 'websocket'] })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer() server!: Server;
  constructor(private readonly sessions: SessionService, @Inject('APP_ORIGIN') private readonly origin: string,
    private readonly db: DatabaseService, private readonly access: ChannelAccessService, private readonly connections: ConnectionsService) {}

  handleConnection(socket: Socket): void { this.connections.add(socket); }

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
      const status = error instanceof HttpException ? error.getStatus() : 500;
      const code = status === 400 ? 'VALIDATION_ERROR' : status === 401 ? 'UNAUTHENTICATED'
        : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR';
      return { ok: false, error: { code, message: 'Channel subscription could not be updated.', requestId: randomUUID() } };
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
