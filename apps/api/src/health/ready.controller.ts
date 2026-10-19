import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '../database/database.service.js';
import { ShutdownError, ShutdownState } from '../shutdown/shutdown-state.js';

@Controller('health')
export class ReadyController {
  constructor(private readonly db: DatabaseService, private readonly shutdown: ShutdownState) {}

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(@Res({ passthrough: true }) response: Response) {
    try {
      if (this.shutdown.draining) throw new ShutdownError();
      await this.db.checkReady();
      if (this.shutdown.draining) throw new ShutdownError();
      return { status: 'ready' };
    } catch (error) {
      response.status(503);
      response.locals.diagnosticCode = error instanceof ShutdownError ? 'SHUTTING_DOWN' : 'DATABASE_UNAVAILABLE';
      if (error instanceof ShutdownError) response.setHeader('Retry-After', '1');
      return { status: 'unavailable' };
    }
  }
}
