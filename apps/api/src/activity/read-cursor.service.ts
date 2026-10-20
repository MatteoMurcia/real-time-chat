import { BadRequestException, Injectable } from '@nestjs/common';
import type { ReadCursorResponse } from '@real-time-chat/contracts/activity';
import { ChannelAccessService, validateChannelId } from '../channels/channel-access.service.js';
import { DatabaseService } from '../database/database.service.js';

export function validateReadSequence(body: unknown): bigint {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException();
  const input = body as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || typeof input.lastReadSequence !== 'string'
    || !/^(?:0|[1-9]\d{0,18})$/.test(input.lastReadSequence)) throw new BadRequestException();
  const sequence = BigInt(input.lastReadSequence);
  if (sequence > 9223372036854775807n) throw new BadRequestException();
  return sequence;
}

@Injectable()
export class ReadCursorService {
  constructor(private readonly db: DatabaseService, private readonly access: ChannelAccessService) {}

  get(userId: string, id: string): Promise<ReadCursorResponse> { return this.cursor(userId, id, null); }

  advance(userId: string, id: string, body: unknown): Promise<ReadCursorResponse> {
    return this.cursor(userId, id, validateReadSequence(body));
  }

  private async cursor(userId: string, id: string, sequence: bigint | null): Promise<ReadCursorResponse> {
    const channelId = validateChannelId(id);
    return this.db.$transaction(async tx => {
      await this.access.lockChannel(tx, channelId);
      await this.access.requireMember(userId, channelId, tx);
      if (sequence !== null && sequence > 0n && !await tx.message.findUnique({
        where: { channelId_sequence: { channelId, sequence } }, select: { id: true },
      })) throw new BadRequestException();
      const where = { userId_channelId: { userId, channelId } };
      let current = await tx.readCursor.findUnique({ where, select: { lastReadSequence: true } });
      // The channel lock serializes updates across sessions and orders them against leave/send.
      if (sequence !== null && (!current || sequence > current.lastReadSequence)) {
        current = await tx.readCursor.upsert({ where, create: { userId, channelId, lastReadSequence: sequence },
          update: { lastReadSequence: sequence }, select: { lastReadSequence: true } });
      }
      return { channelId, lastReadSequence: (current?.lastReadSequence ?? 0n).toString() };
    });
  }
}
