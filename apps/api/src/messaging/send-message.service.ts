import { ConflictException, Injectable } from '@nestjs/common';
import type { PublicMessage, SendMessageRequest } from '@real-time-chat/contracts/messages';
import { ChannelAccessService } from '../channels/channel-access.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { Prisma } from '../generated/prisma/client.js';

const publicMessage = {
  id: true, channelId: true, clientMessageId: true, sequence: true, body: true, createdAt: true,
  author: { select: { id: true, displayName: true } },
} satisfies Prisma.MessageSelect;
const serialize = (message: Prisma.MessageGetPayload<{ select: typeof publicMessage }>): PublicMessage => ({
  ...message, sequence: message.sequence.toString(), createdAt: message.createdAt.toISOString(),
});

@Injectable()
export class SendMessageService {
  constructor(private readonly db: DatabaseService, private readonly access: ChannelAccessService) {}

  // The caller holds the local channel queue through commit and emission.
  async send(authorId: string, input: SendMessageRequest): Promise<{ message: PublicMessage; created: boolean }> {
    return this.db.$transaction(async tx => {
      await this.access.lockChannel(tx, input.channelId);
      await this.access.requireMember(authorId, input.channelId, tx);
      const existing = await tx.message.findUnique({ where: { authorId_clientMessageId: { authorId, clientMessageId: input.clientMessageId } }, select: publicMessage });
      if (existing) {
        if (existing.channelId !== input.channelId || existing.body !== input.body) throw new ConflictException();
        return { message: serialize(existing), created: false };
      }
      const channel = await tx.channel.update({ where: { id: input.channelId }, data: { lastSequence: { increment: 1 } }, select: { lastSequence: true } });
      const message = await tx.message.create({ data: { ...input, authorId, sequence: channel.lastSequence }, select: publicMessage });
      return { message: serialize(message), created: true };
    });
  }
}
