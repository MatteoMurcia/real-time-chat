import { BadRequestException } from '@nestjs/common';
import { historyCursor } from './history-cursor.js';

function boundary(channelId: string, input: unknown): bigint {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(input)) throw new BadRequestException();
  try {
    const value: unknown = JSON.parse(Buffer.from(input, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== channelId
      || typeof value[2] !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(value[2]) || value[3] !== value[2]) throw new Error();
    const sequence = BigInt(value[2]);
    if (sequence > 9223372036854775807n || historyCursor(channelId, sequence, sequence) !== input) throw new Error();
    return sequence;
  } catch { throw new BadRequestException(); }
}

export function syncQuery(channelId: string, query: unknown): { after: bigint; until: bigint | null; limit: number } {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new BadRequestException();
  const input = query as Record<string, unknown>;
  if (Object.keys(input).some(key => !['after', 'until', 'limit'].includes(key))) throw new BadRequestException();
  const limit = input.limit === undefined ? 50 : typeof input.limit === 'string' && /^(?:[1-9]\d?|100)$/.test(input.limit) ? Number(input.limit) : 0;
  if (!limit) throw new BadRequestException();
  const after = boundary(channelId, input.after), until = input.until === undefined ? null : boundary(channelId, input.until);
  if (until !== null && after > until) throw new BadRequestException();
  return { after, until, limit };
}
