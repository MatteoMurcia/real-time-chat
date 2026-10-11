import { BadRequestException } from '@nestjs/common';
import type { SendMessageRequest } from '@real-time-chat/contracts/messages';
import { validateChannelId } from '../channels/channel-access.service.js';

export function validateMessage(value: unknown): SendMessageRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['channelId', 'clientMessageId', 'body'].includes(key))
    || typeof input.channelId !== 'string' || typeof input.clientMessageId !== 'string'
    || typeof input.body !== 'string' || !input.body.trim() || [...input.body].length > 2000
    || input.body.includes('\0') || Buffer.from(input.body).toString('utf8') !== input.body) throw new BadRequestException();
  return { channelId: validateChannelId(input.channelId), clientMessageId: validateChannelId(input.clientMessageId), body: input.body };
}
