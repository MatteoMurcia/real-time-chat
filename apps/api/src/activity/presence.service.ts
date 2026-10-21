import { BadRequestException, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import type { PresenceRequest, PresenceResponse } from '@real-time-chat/contracts/activity';
import { DatabaseService } from '../database/database.service.js';
import { ChannelAccessService, validateChannelId } from '../channels/channel-access.service.js';
import { ConnectionsService } from '../realtime/connections.service.js';
import { ShutdownError, ShutdownState } from '../shutdown/shutdown-state.js';
import { socketError } from '../realtime/socket-error.js';

export function validatePresence(body: unknown): PresenceRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('channelId' in body) || typeof body.channelId !== 'string'
    || !('userIds' in body) || !Array.isArray(body.userIds) || !body.userIds.length || body.userIds.length > 100
    || Object.keys(body).length !== 2) throw new BadRequestException();
  const userIds = body.userIds.map((id: unknown) => {
    if (typeof id !== 'string') throw new BadRequestException();
    return validateChannelId(id);
  });
  if (new Set(userIds).size !== userIds.length) throw new BadRequestException();
  return { channelId: validateChannelId(body.channelId), userIds };
}

@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly listener: Subscription;
  constructor(private readonly db: DatabaseService, private readonly access: ChannelAccessService,
    private readonly connections: ConnectionsService, private readonly shutdown: ShutdownState) {
    this.listener = connections.presenceChanges.subscribe(userId => { void this.invalidate(userId); });
  }

  // The gateway holds the process-local channel queue through authorization and reply.
  async snapshot(userId: string, input: PresenceRequest): Promise<PresenceResponse> {
    return this.db.$transaction(async tx => {
      await this.access.lockChannel(tx, input.channelId);
      await this.access.requireMember(userId, input.channelId, tx);
      const members = await tx.membership.findMany({ where: { channelId: input.channelId, userId: { in: input.userIds } }, select: { userId: true } });
      const memberIds = new Set(members.map(member => member.userId));
      const candidates = this.connections.connectedSessionIds([...memberIds]);
      const sessions = candidates.length ? await tx.session.findMany({
        where: { id: { in: candidates }, expiresAt: { gt: new Date() } }, select: { id: true, expiresAt: true },
      }) : [];
      const valid = new Set(sessions.filter(session => session.expiresAt.getTime() > Date.now()).map(session => session.id));
      return { channelId: input.channelId, users: input.userIds.filter(id => memberIds.has(id))
        .map(id => ({ userId: id, online: this.connections.countConnections(id, valid) > 0 })) };
    });
  }

  private async invalidate(userId: string): Promise<void> {
    let release = () => {};
    try {
      release = this.shutdown.enter();
      const peers = await this.db.membership.findMany({
        where: { channel: { memberships: { some: { userId } } } }, select: { userId: true }, distinct: ['userId'],
      });
      // Invalidation carries no actor/channel/status; the next authorized snapshot supplies data.
      this.connections.presenceChanged(peers.map(peer => peer.userId));
    } catch (error) { if (!(error instanceof ShutdownError)) socketError(error, { stage: 'publish' }); }
    finally { release(); }
  }

  onModuleDestroy(): void { this.listener.unsubscribe(); }
}
