import { HttpException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ApiError } from '@real-time-chat/contracts';

const logger = new Logger('SocketError');
export function socketError(error: unknown): ApiError {
  const status = error instanceof HttpException ? error.getStatus() : 500;
  const code = status === 400 ? 'VALIDATION_ERROR' : status === 401 ? 'UNAUTHENTICATED'
    : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'INTERNAL_ERROR';
  const result: ApiError = { code, message: 'The operation could not be completed.', requestId: randomUUID() };
  if (code === 'INTERNAL_ERROR') logger.error({ code, requestId: result.requestId });
  return result;
}
