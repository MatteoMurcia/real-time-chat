import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ApiError } from '@real-time-chat/contracts';
import { diagnostic, type Diagnostic } from '../logging/logger.js';

export function socketError(error: unknown, context: Pick<Diagnostic, 'clientMessageId' | 'channelId' | 'stage' | 'durationMs'> = {}, requestId = randomUUID()): ApiError {
  const status = error instanceof HttpException ? error.getStatus() : 500;
  const code = status === 400 ? 'VALIDATION_ERROR' : status === 401 ? 'UNAUTHENTICATED'
    : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR';
  const result: ApiError = { code, message: 'The operation could not be completed.', requestId };
  diagnostic({ event: 'socket.failure', code, requestId, ...context });
  return result;
}
