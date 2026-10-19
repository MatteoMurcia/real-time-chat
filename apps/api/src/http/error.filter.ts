import { randomUUID } from 'node:crypto';
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { ApiError, ErrorCode } from '@real-time-chat/contracts';
import { ValidationError } from './validation-error.js';
import { diagnostic } from '../logging/logger.js';
import { ShutdownError } from '../shutdown/shutdown-state.js';

const publicErrors: Record<number, { code: ErrorCode; message: string }> = {
  400: { code: 'VALIDATION_ERROR', message: 'The request is invalid.' },
  401: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
  403: { code: 'FORBIDDEN', message: 'Access is denied.' },
  404: { code: 'NOT_FOUND', message: 'The resource was not found.' },
  409: { code: 'CONFLICT', message: 'The request conflicts with the current state.' },
  413: { code: 'VALIDATION_ERROR', message: 'The request is too large.' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
};

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const response = host.switchToHttp().getResponse();
    if (httpAdapter.isHeadersSent(response)) return;
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const mapped = exception instanceof ShutdownError
      ? { code: 'INTERNAL_ERROR' as const, message: 'The service is shutting down. Retry later.' } : publicErrors[status];
    const body: ApiError = {
      ...(mapped ?? { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' }),
      requestId: response.getHeader('X-Request-Id') ?? randomUUID(),
      ...(exception instanceof ValidationError ? { fieldErrors: exception.fieldErrors } : {}),
    };
    if (!mapped && !response.getHeader('X-Request-Id')) diagnostic({ event: 'http.failure', code: body.code, requestId: body.requestId });
    response.locals.diagnosticCode = exception instanceof ShutdownError ? 'SHUTTING_DOWN' : body.code;
    if (exception instanceof ShutdownError) httpAdapter.setHeader(response, 'Retry-After', '1');
    httpAdapter.setHeader(response, 'X-Request-Id', body.requestId);
    httpAdapter.setHeader(response, 'Cache-Control', 'no-store');
    httpAdapter.reply(response, body, mapped ? status : 500);
  }
}
