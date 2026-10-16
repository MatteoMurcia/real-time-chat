import { BadRequestException, Body, Controller, Delete, Get, Header, Headers, Param, Post, Put, Query } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { SessionService } from '../identity/session.service.js';
import { CsrfService } from '../identity/csrf.service.js';
import { ChannelsService } from './channels.service.js';
import { RateLimitService } from '../security/rate-limit.service.js';

@Controller('channels')
export class ChannelsController {
  constructor(private readonly sessions: SessionService, private readonly csrf: CsrfService, private readonly channels: ChannelsService, private readonly limits: RateLimitService) {}

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
    this.limits.consume('createChannel', session.user.id);
    this.csrf.verifySession(headers, session.id);
    if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] ?? '')) throw new BadRequestException();
    return this.channels.create(session.user.id, body);
  }

  @Put(':id/membership')
  @Header('Cache-Control', 'no-store')
  join(@Headers() headers: IncomingHttpHeaders, @Param('id') id: string, @Body() body: unknown, @Query() query: object) {
    return this.membership(headers, id, body, query, true);
  }

  @Delete(':id/membership')
  @Header('Cache-Control', 'no-store')
  leave(@Headers() headers: IncomingHttpHeaders, @Param('id') id: string, @Body() body: unknown, @Query() query: object) {
    return this.membership(headers, id, body, query, false);
  }

  private async membership(headers: IncomingHttpHeaders, id: string, body: unknown, query: object, isMember: boolean) {
    const session = await this.sessions.authenticate(headers.cookie);
    this.csrf.verifySession(headers, session.id);
    if (body != null || Object.keys(query).length) throw new BadRequestException();
    return this.channels.setMembership(session.user.id, id, isMember);
  }
}
