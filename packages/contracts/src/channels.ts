export interface CreateChannelRequest { name: string; slug: string }
export interface PublicChannel {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  isMember: boolean;
}
export interface CreateChannelResponse { channel: PublicChannel }
export interface ChannelPage { channels: PublicChannel[]; nextCursor: string | null }
export interface MembershipResponse { channelId: string; isMember: boolean }
