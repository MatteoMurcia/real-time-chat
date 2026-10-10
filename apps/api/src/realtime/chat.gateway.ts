import { Inject, UnauthorizedException } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayInit } from '@nestjs/websockets';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'socket.io';
import type { ApiError } from '@real-time-chat/contracts';
import { SessionService } from '../identity/session.service.js';
import { verifyOrigin } from '../identity/request-origin.js';

@WebSocketGateway({ path: '/socket.io', serveClient: false, maxHttpBufferSize: 8192, transports: ['polling', 'websocket'] })
export class ChatGateway implements OnGatewayInit {
  constructor(private readonly sessions: SessionService, @Inject('APP_ORIGIN') private readonly origin: string) {}

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
