import { BadRequestException, Body, Controller, Get, Header, Headers, Param, Put, Query } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { SessionService } from '../identity/session.service.js';
import { CsrfService } from '../identity/csrf.service.js';
import { ReadCursorService } from './read-cursor.service.js';

@Controller('channels/:id/read-cursor')
export class ActivityController {
  constructor(private readonly sessions: SessionService, private readonly csrf: CsrfService, private readonly cursors: ReadCursorService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@Headers() headers: IncomingHttpHeaders, @Param('id') id: string, @Query() query: object) {
    const session = await this.sessions.authenticate(headers.cookie);
    if (Object.keys(query).length) throw new BadRequestException();
    return this.cursors.get(session.user.id, id);
  }

  @Put()
  @Header('Cache-Control', 'no-store')
  async advance(@Headers() headers: IncomingHttpHeaders, @Param('id') id: string, @Body() body: unknown, @Query() query: object) {
    const session = await this.sessions.authenticate(headers.cookie);
    this.csrf.verifySession(headers, session.id);
    if (Object.keys(query).length || !/^application\/json(?:\s*;|$)/i.test(headers['content-type'] ?? '')) throw new BadRequestException();
    return this.cursors.advance(session.user.id, id, body);
  }
}
