import { BadRequestException, Body, Controller, Get, Header, Headers, Post, Res } from '@nestjs/common';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { CsrfResponse } from '@real-time-chat/contracts/auth';
import { CsrfService } from './csrf.service.js';
import { RegistrationService } from './registration.service.js';

@Controller('auth')
export class RegistrationController {
  constructor(private readonly csrf: CsrfService, private readonly registration: RegistrationService) {}

  @Get('csrf')
  @Header('Cache-Control', 'no-store')
  csrfToken(@Headers() headers: IncomingHttpHeaders, @Res({ passthrough: true }) response: ServerResponse): CsrfResponse {
    const issued = this.csrf.issue(headers);
    response.setHeader('Set-Cookie', issued.cookie);
    return { csrfToken: issued.csrfToken };
  }

  @Post('register')
  @Header('Cache-Control', 'no-store')
  register(@Headers() headers: IncomingHttpHeaders, @Body() body: unknown) {
    this.csrf.verify(headers);
    if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] ?? '')) throw new BadRequestException();
    return this.registration.register(body);
  }
}
