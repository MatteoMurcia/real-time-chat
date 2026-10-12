import type { ApiError } from './errors.js';

export interface SendMessageRequest { channelId: string; clientMessageId: string; body: string }
export interface PublicMessage {
  id: string;
  channelId: string;
  clientMessageId: string;
  sequence: string;
  body: string;
  author: { id: string; displayName: string };
  createdAt: string;
}
export type SendMessageAck = { ok: true; data: PublicMessage } | { ok: false; error: ApiError };

export interface MessagePage { items: PublicMessage[]; olderCursor: string | null; snapshotCursor: string }
