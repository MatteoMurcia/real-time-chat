import { BadRequestException, Injectable } from '@nestjs/common';
import type { MessagePage } from '@real-time-chat/contracts/messages';
import { DatabaseService } from '../database/database.service.js';
import { ChannelAccessService, validateChannelId } from '../channels/channel-access.service.js';
import { historyCursor, historyQuery } from './history-cursor.js';
import { publicMessage, serializeMessage } from './public-message.js';

@Injectable()
export class HistoryService {
  constructor(private readonly db: DatabaseService, private readonly access: ChannelAccessService) {}

  async list(userId: string, id: string, query: unknown): Promise<MessagePage> {
    const channelId = validateChannelId(id);
    const { limit, before } = historyQuery(channelId, query);
    return this.db.$transaction(async tx => {
      // Share the write/membership boundary so H represents committed messages and leave has a defined order.
      await this.access.lockChannel(tx, channelId);
      await this.access.requireMember(userId, channelId, tx);
      const { lastSequence } = await tx.channel.findUniqueOrThrow({ where: { id: channelId }, select: { lastSequence: true } });
      const snapshot = before?.snapshot ?? lastSequence;
      if (snapshot > lastSequence) throw new BadRequestException();
      const rows = await tx.message.findMany({
        where: { channelId, sequence: { lte: snapshot, ...(before ? { lt: before.sequence } : {}) } },
        orderBy: { sequence: 'desc' }, take: limit + 1, select: publicMessage,
      });
      const hasOlder = rows.length > limit;
      const items = rows.slice(0, limit).reverse().map(serializeMessage);
      return { items, olderCursor: hasOlder ? historyCursor(channelId, BigInt(items[0]!.sequence), snapshot) : null,
        snapshotCursor: historyCursor(channelId, snapshot, snapshot) };
    });
  }
}
