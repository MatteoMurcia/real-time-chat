import { BadRequestException, Body, Controller, Get, Header, Headers, Post, Req, Res } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimitService } from '../security/rate-limit.service.js';
import { normalizeIp } from '../config.js';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { CsrfResponse } from '@real-time-chat/contracts/auth';
import { CsrfService } from './csrf.service.js';
import { RegistrationService } from './registration.service.js';

@Controller('auth')
export class RegistrationController {
  constructor(private readonly csrf: CsrfService, private readonly registration: RegistrationService, private readonly limits: RateLimitService) {}

  @Get('csrf')
  @Header('Cache-Control', 'no-store')
  csrfToken(@Headers() headers: IncomingHttpHeaders, @Res({ passthrough: true }) response: ServerResponse): CsrfResponse {
    const issued = this.csrf.issue(headers);
    response.setHeader('Set-Cookie', issued.cookie);
    return { csrfToken: issued.csrfToken };
  }

  @Post('register')
  @Header('Cache-Control', 'no-store')
  register(@Headers() headers: IncomingHttpHeaders, @Body() body: unknown, @Req() request: Request) {
    this.limits.consume('register', normalizeIp(request.ip ?? request.socket.remoteAddress ?? 'unknown'));
    this.csrf.verify(headers);
    if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] ?? '')) throw new BadRequestException();
    return this.registration.register(body);
  }
}
