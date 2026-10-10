import { ForbiddenException } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';

export function verifyOrigin(headers: IncomingHttpHeaders, expected: string): void {
  let origin = headers.origin;
  if (!origin && headers.referer) {
    try { origin = new URL(headers.referer).origin; } catch { throw new ForbiddenException(); }
  }
  if (origin !== expected) throw new ForbiddenException();
}
