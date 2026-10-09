import { BadRequestException, Body, Controller, Get, Header, Headers, HttpCode, Post, Res } from '@nestjs/common';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { SessionResponse } from '@real-time-chat/contracts/auth';
import { CsrfService } from './csrf.service.js';
import { SessionService } from './session.service.js';

@Controller('auth')
export class SessionController {
  constructor(private readonly sessions: SessionService, private readonly csrf: CsrfService) {}

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async login(@Headers() headers: IncomingHttpHeaders, @Body() body: unknown,
    @Res({ passthrough: true }) response: ServerResponse): Promise<SessionResponse> {
    this.csrf.verify(headers);
    if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] ?? '')) throw new BadRequestException();
    const session = await this.sessions.login(body);
    response.setHeader('Set-Cookie', session.cookie);
    return session.body;
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  me(@Headers() headers: IncomingHttpHeaders): Promise<SessionResponse> {
    return this.sessions.me(headers.cookie);
  }
}
