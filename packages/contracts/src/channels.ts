import type { ApiError } from './errors.js';

export interface CreateChannelRequest { name: string; slug: string }
export interface PublicChannel {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  isMember: boolean;
}
export interface CreateChannelResponse { channel: PublicChannel }
export interface ListedChannel extends PublicChannel { unreadCount: number | null }
export interface ChannelPage { channels: ListedChannel[]; nextCursor: string | null }
export interface MembershipResponse { channelId: string; isMember: boolean }
export interface ChannelSubscriptionRequest { channelId: string }
export type ChannelSubscriptionAck = { ok: true; data: { channelId: string; subscribed: boolean } } | { ok: false; error: ApiError };
