import type { PublicMessage } from '@real-time-chat/contracts/messages';

export function isMessage(value: unknown): value is PublicMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<PublicMessage>;
  return typeof message.id === 'string' && typeof message.channelId === 'string'
    && typeof message.clientMessageId === 'string' && typeof message.sequence === 'string'
    && /^[1-9]\d{0,18}$/.test(message.sequence) && BigInt(message.sequence) <= 9223372036854775807n
    && typeof message.body === 'string' && [...message.body].length <= 2000 && !!message.body.trim()
    && typeof message.author?.id === 'string' && typeof message.author.displayName === 'string'
    && typeof message.createdAt === 'string' && Number.isFinite(Date.parse(message.createdAt));
}
