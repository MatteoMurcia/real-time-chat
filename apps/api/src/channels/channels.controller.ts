import { BadRequestException, Body, Controller, Get, Header, Headers, Post, Query } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { SessionService } from '../identity/session.service.js';
import { CsrfService } from '../identity/csrf.service.js';
import { ChannelsService } from './channels.service.js';

@Controller('channels')
export class ChannelsController {
  constructor(private readonly sessions: SessionService, private readonly csrf: CsrfService, private readonly channels: ChannelsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Headers() headers: IncomingHttpHeaders, @Query() query: unknown) {
    const session = await this.sessions.authenticate(headers.cookie);
    return this.channels.list(session.user.id, query);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  async create(@Headers() headers: IncomingHttpHeaders, @Body() body: unknown) {
    const session = await this.sessions.authenticate(headers.cookie);
    this.csrf.verifySession(headers, session.id);
    if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] ?? '')) throw new BadRequestException();
    return this.channels.create(session.user.id, body);
  }
}
