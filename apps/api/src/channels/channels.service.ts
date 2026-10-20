import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { ChannelPage, CreateChannelRequest, CreateChannelResponse, MembershipResponse } from '@real-time-chat/contracts/channels';
import { DatabaseService } from '../database/database.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { ChannelAccessService, validateChannelId } from './channel-access.service.js';
import { ConnectionsService } from '../realtime/connections.service.js';

const validSlug = (slug: string) => slug.length >= 3 && slug.length <= 48 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
const publicChannel = { id: true, name: true, slug: true, createdAt: true } as const;

export function validateChannel(value: unknown): CreateChannelRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['name', 'slug'].includes(key))
    || typeof input.name !== 'string' || typeof input.slug !== 'string') throw new BadRequestException();
  const name = input.name.trim().normalize('NFC').replace(/ +/g, ' ');
  const slug = input.slug.trim();
  if ([...name].length < 2 || [...name].length > 80 || !/^[\p{L}\p{M}\p{N} .'-]+$/u.test(name) || !validSlug(slug)) throw new BadRequestException();
  return { name, slug };
}

export function validateChannelPage(value: unknown): { limit: number; after?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException();
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some(key => !['limit', 'cursor'].includes(key))) throw new BadRequestException();
  if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^(?:[1-9][0-9]?|100)$/.test(query.limit))) throw new BadRequestException();
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (query.cursor === undefined) return { limit };
  if (typeof query.cursor !== 'string' || query.cursor.length > 100 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new BadRequestException();
  const decoded = Buffer.from(query.cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith('v1:') || !validSlug(decoded.slice(3)) || Buffer.from(decoded).toString('base64url') !== query.cursor) throw new BadRequestException();
  return { limit, after: decoded.slice(3) };
}

@Injectable()
export class ChannelsService {
  constructor(private readonly db: DatabaseService, private readonly access: ChannelAccessService, private readonly connections: ConnectionsService) {}

  async setMembership(userId: string, id: string, isMember: boolean): Promise<MembershipResponse> {
    const channelId = validateChannelId(id);
    await this.connections.withChannel(channelId, async () => {
      await this.db.$transaction(async tx => {
        await this.access.lockChannel(tx, channelId);
        if (isMember) {
          await tx.membership.upsert({ where: { userId_channelId: { userId, channelId } }, create: { userId, channelId }, update: {} });
        } else {
          await tx.membership.deleteMany({ where: { userId, channelId } });
        }
      });
      if (!isMember) this.connections.revokeChannel(userId, channelId);
      this.connections.activityChanged([userId]);
    });
    return { channelId, isMember };
  }

  async create(userId: string, body: unknown): Promise<CreateChannelResponse> {
    const { name, slug } = validateChannel(body);
    try {
      // Nested writes roll back the channel if its initial membership cannot be created.
      const channel = await this.db.channel.create({
        data: { name, nameKey: name.toLowerCase(), slug, createdBy: userId, memberships: { create: { userId } } },
        select: publicChannel,
      });
      return { channel: { ...channel, createdAt: channel.createdAt.toISOString(), isMember: true } };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException();
      throw error;
    }
  }

  async list(userId: string, query: unknown): Promise<ChannelPage> {
    const { limit, after } = validateChannelPage(query);
    const rows = await this.db.channel.findMany({
      where: after ? { slug: { gt: after } } : {}, orderBy: { slug: 'asc' }, take: limit + 1,
      select: publicChannel,
    });
    const page = rows.slice(0, limit);
    const counts = page.length ? await this.db.$queryRaw<{ channelId: string; unreadCount: number }[]>`
      SELECT ms."channelId", count(m.id)::int AS "unreadCount"
      FROM "Membership" ms
      LEFT JOIN "ReadCursor" r ON r."userId" = ms."userId" AND r."channelId" = ms."channelId"
      LEFT JOIN "Message" m ON m."channelId" = ms."channelId"
        AND m.sequence > COALESCE(r."lastReadSequence", 0) AND m."authorId" <> ms."userId"
      WHERE ms."userId" = ${userId}::uuid AND ms."channelId" IN (${Prisma.join(page.map(channel => channel.id))})
      GROUP BY ms."channelId"` : [];
    const byChannel = new Map(counts.map(row => [row.channelId, row.unreadCount]));
    const channels = page.map(({ createdAt, ...channel }) => ({
      ...channel, createdAt: createdAt.toISOString(), isMember: byChannel.has(channel.id), unreadCount: byChannel.get(channel.id) ?? null,
    }));
    return { channels, nextCursor: rows.length > limit ? Buffer.from(`v1:${channels.at(-1)!.slug}`).toString('base64url') : null };
  }
}
