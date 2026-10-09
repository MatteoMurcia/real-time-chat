import { randomUUID } from 'node:crypto';
import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { ApiError, ErrorCode } from '@real-time-chat/contracts';

const publicErrors: Record<number, { code: ErrorCode; message: string }> = {
  400: { code: 'VALIDATION_ERROR', message: 'The request is invalid.' },
  401: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
  403: { code: 'FORBIDDEN', message: 'Access is denied.' },
  404: { code: 'NOT_FOUND', message: 'The resource was not found.' },
  409: { code: 'CONFLICT', message: 'The request conflicts with the current state.' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const response = host.switchToHttp().getResponse();
    if (httpAdapter.isHeadersSent(response)) return;
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const mapped = publicErrors[status];
    const body: ApiError = {
      ...(mapped ?? { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' }),
      requestId: randomUUID(),
    };
    if (!mapped) this.logger.error({ code: body.code, requestId: body.requestId });
    httpAdapter.setHeader(response, 'X-Request-Id', body.requestId);
    httpAdapter.setHeader(response, 'Cache-Control', 'no-store');
    httpAdapter.reply(response, body, mapped ? status : 500);
  }
}
