import { Controller, Get, Header } from '@nestjs/common';

@Controller('health')
export class LiveController {
  @Get('live')
  @Header('Cache-Control', 'no-store')
  live() {
    return { status: 'ok' };
  }
}
