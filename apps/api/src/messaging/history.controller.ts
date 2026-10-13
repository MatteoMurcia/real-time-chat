import { Controller, Get, Header, Headers, Param, Query } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { SessionService } from '../identity/session.service.js';
import { HistoryService } from './history.service.js';
import { SyncService } from './sync.service.js';

@Controller('channels/:id/messages')
export class HistoryController {
  constructor(private readonly sessions: SessionService, private readonly history: HistoryService, private readonly sync: SyncService) {}

  @Get('sync')
  @Header('Cache-Control', 'no-store')
  async recover(@Headers() headers: IncomingHttpHeaders, @Param('id') id: string, @Query() query: unknown) {
    const session = await this.sessions.authenticate(headers.cookie);
    return this.sync.list(session.user.id, id, query);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Headers() headers: IncomingHttpHeaders, @Param('id') id: string, @Query() query: unknown) {
    const session = await this.sessions.authenticate(headers.cookie);
    return this.history.list(session.user.id, id, query);
  }
}
