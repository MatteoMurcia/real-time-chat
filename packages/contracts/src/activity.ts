export interface AdvanceReadCursorRequest { lastReadSequence: string }
export interface ReadCursorResponse { channelId: string; lastReadSequence: string }
