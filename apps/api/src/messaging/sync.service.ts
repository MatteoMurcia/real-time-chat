import { BadRequestException, Injectable } from '@nestjs/common';
import type { MessageSyncPage } from '@real-time-chat/contracts/messages';
import { DatabaseService } from '../database/database.service.js';
import { ChannelAccessService, validateChannelId } from '../channels/channel-access.service.js';
import { historyCursor } from './history-cursor.js';
import { syncQuery } from './sync-query.js';
import { publicMessage, serializeMessage } from './public-message.js';

@Injectable()
export class SyncService {
  constructor(private readonly db: DatabaseService, private readonly access: ChannelAccessService) {}

  async list(userId: string, id: string, query: unknown): Promise<MessageSyncPage> {
    const channelId = validateChannelId(id), { after, until, limit } = syncQuery(channelId, query);
    return this.db.$transaction(async tx => {
      // A writer must commit or roll back before its sequence can become a recovery boundary.
      await this.access.lockChannel(tx, channelId);
      await this.access.requireMember(userId, channelId, tx);
      const { lastSequence } = await tx.channel.findUniqueOrThrow({ where: { id: channelId }, select: { lastSequence: true } });
      const high = until ?? lastSequence;
      if (after > high || high > lastSequence) throw new BadRequestException();
      const rows = await tx.message.findMany({ where: { channelId, sequence: { gt: after, lte: high } },
        orderBy: { sequence: 'asc' }, take: limit + 1, select: publicMessage });
      const hasMore = rows.length > limit, items = rows.slice(0, limit).map(serializeMessage);
      const next = hasMore ? BigInt(items.at(-1)!.sequence) : high;
      return { items, hasMore, until: historyCursor(channelId, high, high),
        nextCursor: historyCursor(channelId, next, next) };
    });
  }
}
