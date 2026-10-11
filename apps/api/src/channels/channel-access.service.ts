import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { Prisma } from '../generated/prisma/client.js';

export function validateChannelId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new BadRequestException();
  return value.toLowerCase();
}

@Injectable()
export class ChannelAccessService {
  constructor(private readonly db: DatabaseService) {}

  async lockChannel(tx: Prisma.TransactionClient, channelId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Channel" WHERE "id" = ${channelId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundException();
  }

  // Call inside the channel-locked transaction when authorizing a dependent write.
  async requireMember(userId: string, channelId: string, tx: Prisma.TransactionClient = this.db): Promise<void> {
    const membership = await tx.membership.findUnique({ where: { userId_channelId: { userId, channelId } }, select: { userId: true } });
    if (!membership) throw new ForbiddenException();
  }
}
