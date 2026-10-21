import { BadRequestException } from '@nestjs/common';
import type { TypingRequest } from '@real-time-chat/contracts/activity';
import { validateChannelId } from '../channels/channel-access.service.js';

export function validateTyping(body: unknown): TypingRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('channelId' in body)
    || typeof body.channelId !== 'string' || !('typing' in body) || typeof body.typing !== 'boolean'
    || Object.keys(body).length !== 2) throw new BadRequestException();
  return { channelId: validateChannelId(body.channelId), typing: body.typing };
}
