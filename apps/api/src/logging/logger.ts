import { Logger } from '@nestjs/common';
import type { ErrorCode } from '@real-time-chat/contracts';

export interface Diagnostic {
  event: 'http.request' | 'http.failure' | 'socket.failure' | 'message.send';
  requestId: string;
  code?: ErrorCode | 'DATABASE_UNAVAILABLE';
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  clientMessageId?: string;
  channelId?: string;
  stage?: 'authorize' | 'persist' | 'publish';
  outcome?: 'created' | 'duplicate';
}

const logger = new Logger('Diagnostics');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function diagnostic(input: Diagnostic): void {
  // Copy the allowlist explicitly: never serialize a request, payload or exception.
  const record = {
    event: input.event, requestId: input.requestId, code: input.code,
    method: input.method, route: input.route, status: input.status, durationMs: input.durationMs,
    clientMessageId: input.clientMessageId && uuid.test(input.clientMessageId) ? input.clientMessageId.toLowerCase() : undefined,
    channelId: input.channelId && uuid.test(input.channelId) ? input.channelId.toLowerCase() : undefined,
    stage: input.stage, outcome: input.outcome,
  };
  if (input.code === 'INTERNAL_ERROR' || input.code === 'DATABASE_UNAVAILABLE') logger.error(record);
  else if (input.code) logger.warn(record);
  else logger.log(record);
}
