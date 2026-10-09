import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, UnauthorizedException, type OnModuleInit } from '@nestjs/common';
import type { LoginRequest, SessionResponse } from '@real-time-chat/contracts/auth';
import { DatabaseService } from '../database/database.service.js';
import { hashPassword, verifyPassword } from './password.js';

const publicUser = { id: true, email: true, displayName: true, createdAt: true } as const;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export function validateLogin(body: unknown): LoginRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException();
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !['email', 'password'].includes(key))
    || typeof input.email !== 'string' || typeof input.password !== 'string') throw new BadRequestException();
  const email = input.email.trim().toLowerCase();
  if (!email || email.length > 254 || !input.password || [...input.password].length > 128
    || Buffer.from(input.password).toString('utf8') !== input.password) throw new UnauthorizedException();
  return { email, password: input.password };
}

export class SessionService implements OnModuleInit {
  private dummyHash = '';
  private readonly cookieName: string;
  private readonly secure: boolean;

  constructor(private readonly db: DatabaseService, origin: string, private readonly ttlSeconds: number,
    private readonly now = () => Date.now()) {
    this.secure = origin.startsWith('https:');
    this.cookieName = this.secure ? '__Host-chat_session' : 'chat_session';
  }

  async onModuleInit(): Promise<void> {
    // Unknown accounts still perform the same password derivation as known accounts.
    this.dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  }

  async login(body: unknown): Promise<{ cookie: string; body: SessionResponse }> {
    const { email, password } = validateLogin(body);
    const user = await this.db.user.findUnique({ where: { email }, select: { ...publicUser, passwordHash: true } });
    const matches = await verifyPassword(password, user?.passwordHash ?? this.dummyHash);
    if (!user || !matches) throw new UnauthorizedException();
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(this.now() + this.ttlSeconds * 1000);
    await this.db.session.create({ data: { userId: user.id, tokenHash: digest(token), expiresAt } });
    return {
      cookie: `${this.cookieName}=${token}; Path=/; Max-Age=${this.ttlSeconds}; HttpOnly; SameSite=Lax${this.secure ? '; Secure' : ''}`,
      body: {
        user: { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt.toISOString() },
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  async me(cookie: string | undefined): Promise<SessionResponse> {
    const cookies = (cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${this.cookieName}=`));
    const token = cookies[0]?.slice(this.cookieName.length + 1);
    if (cookies.length !== 1 || !token || !/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException();
    const session = await this.db.session.findUnique({
      where: { tokenHash: digest(token) }, select: { expiresAt: true, user: { select: publicUser } },
    });
    if (!session || session.expiresAt.getTime() <= this.now()) throw new UnauthorizedException();
    return { user: { ...session.user, createdAt: session.user.createdAt.toISOString() }, expiresAt: session.expiresAt.toISOString() };
  }
}
