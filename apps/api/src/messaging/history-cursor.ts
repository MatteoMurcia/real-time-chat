import { BadRequestException } from '@nestjs/common';

export function historyCursor(channelId: string, sequence: bigint, snapshot: bigint): string {
  return Buffer.from(JSON.stringify([1, channelId, sequence.toString(), snapshot.toString()])).toString('base64url');
}

export function historyQuery(channelId: string, query: unknown): { limit: number; before: { sequence: bigint; snapshot: bigint } | null } {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new BadRequestException();
  const input = query as Record<string, unknown>;
  if (Object.keys(input).some(key => !['before', 'limit'].includes(key))) throw new BadRequestException();
  const limit = input.limit === undefined ? 50 : typeof input.limit === 'string' && /^(?:[1-9]\d?|100)$/.test(input.limit) ? Number(input.limit) : 0;
  if (!limit) throw new BadRequestException();
  if (input.before === undefined) return { limit, before: null };
  if (typeof input.before !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(input.before)) throw new BadRequestException();
  try {
    const value: unknown = JSON.parse(Buffer.from(input.before, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== channelId
      || ![value[2], value[3]].every(part => typeof part === 'string' && /^[1-9]\d{0,18}$/.test(part))) throw new Error();
    const sequence = BigInt(value[2]), snapshot = BigInt(value[3]);
    if (sequence > snapshot || snapshot > 9223372036854775807n || historyCursor(channelId, sequence, snapshot) !== input.before) throw new Error();
    return { limit, before: { sequence, snapshot } };
  } catch { throw new BadRequestException(); }
}
