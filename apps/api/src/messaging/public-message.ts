import type { PublicMessage } from '@real-time-chat/contracts/messages';
import type { Prisma } from '../generated/prisma/client.js';

export const publicMessage = {
  id: true, channelId: true, clientMessageId: true, sequence: true, body: true, createdAt: true,
  author: { select: { id: true, displayName: true } },
} satisfies Prisma.MessageSelect;

export const serializeMessage = (message: Prisma.MessageGetPayload<{ select: typeof publicMessage }>): PublicMessage => ({
  ...message, sequence: message.sequence.toString(), createdAt: message.createdAt.toISOString(),
});
