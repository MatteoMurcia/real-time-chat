import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { ForbiddenException } from '@nestjs/common';

export class CsrfService {
  private readonly secret = randomBytes(32);
  private readonly cookieName: string;

  constructor(private readonly origin: string, private readonly now = () => Date.now()) {
    this.cookieName = origin.startsWith('https:') ? '__Host-chat_preauth' : 'chat_preauth';
  }

  private checkOrigin(headers: IncomingHttpHeaders): void {
    let origin = headers.origin;
    if (!origin && headers.referer) {
      try { origin = new URL(headers.referer).origin; } catch { throw new ForbiddenException(); }
    }
    if (origin !== this.origin) throw new ForbiddenException();
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }

  issue(headers: IncomingHttpHeaders): { csrfToken: string; cookie: string } {
    this.checkOrigin(headers);
    const payload = `${randomBytes(32).toString('hex')}.${Math.floor(this.now() / 1000) + 600}`;
    const csrfToken = `${payload}.${this.sign(payload)}`;
    const cookie = `${this.cookieName}=${csrfToken}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax`
      + (this.origin.startsWith('https:') ? '; Secure' : '');
    return { csrfToken, cookie };
  }

  verify(headers: IncomingHttpHeaders): void {
    this.checkOrigin(headers);
    const token = headers['x-csrf-token'];
    const cookies = (headers.cookie ?? '').split(';').map(part => part.trim())
      .filter(part => part.startsWith(`${this.cookieName}=`));
    if (typeof token !== 'string' || !/^[a-f0-9]{64}\.[0-9]{10}\.[a-f0-9]{64}$/.test(token)
      || cookies.length !== 1 || cookies[0] !== `${this.cookieName}=${token}`) throw new ForbiddenException();
    const [nonce, expiry, signature] = token.split('.') as [string, string, string];
    if (Number(expiry) <= Math.floor(this.now() / 1000)
      || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.sign(`${nonce}.${expiry}`), 'hex'))) {
      throw new ForbiddenException();
    }
  }
}
