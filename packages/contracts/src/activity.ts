export interface AdvanceReadCursorRequest { lastReadSequence: string }
export interface ReadCursorResponse { channelId: string; lastReadSequence: string }

export interface TypingRequest { channelId: string; typing: boolean }
export interface TypingChanged {
  channelId: string;
  connectionId: string;
  user: { id: string; displayName: string } | null;
}
export type TypingAck = { ok: true; data: { channelId: string } } | { ok: false; error: import('./errors.js').ApiError };
export const TYPING_TTL_MS = 5000;
export const TYPING_INTERVAL_MS = 2000;
