import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '../database/database.service.js';

@Controller('health')
export class ReadyController {
  constructor(private readonly db: DatabaseService) {}

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(@Res({ passthrough: true }) response: Response) {
    try {
      await this.db.checkReady();
      return { status: 'ready' };
    } catch {
      response.status(503);
      response.locals.diagnosticCode = 'DATABASE_UNAVAILABLE';
      return { status: 'unavailable' };
    }
  }
}
