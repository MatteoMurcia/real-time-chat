import { argon2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { FieldErrors, RegistrationRequest, RegistrationResponse } from '@real-time-chat/contracts/auth';
import { DatabaseService } from '../database/database.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { ValidationError } from '../http/validation-error.js';

export function validateRegistration(value: unknown): RegistrationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['email', 'password', 'displayName'].includes(key))) throw new BadRequestException();
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim().normalize('NFC') : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const fields: FieldErrors = {};
  const [local, domain] = email.split('@');
  if (email.length > 254 || !local || local.length > 64 || !domain
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(email)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || domain.split('.').some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    fields.email = 'Enter a valid email address.';
  }
  if ([...displayName].length < 2 || [...displayName].length > 80 || !/^[\p{L}\p{M}\p{N} .'-]+$/u.test(displayName)) {
    fields.displayName = 'Use 2–80 letters, numbers, spaces, apostrophes, periods or hyphens.';
  }
  if ([...password].length < 15 || [...password].length > 128 || Buffer.from(password).toString('utf8') !== password) {
    fields.password = 'Use 15–128 characters.';
  }
  if (Object.keys(fields).length) throw new ValidationError(fields);
  return { email, displayName, password };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await promisify(argon2)('argon2id', {
    message: password, nonce: salt, memory: 19456, passes: 2, parallelism: 1, tagLength: 32,
  });
  const base64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=19456,t=2,p=1$${base64(salt)}$${base64(hash)}`;
}

@Injectable()
export class RegistrationService {
  constructor(private readonly db: DatabaseService) {}

  async register(body: unknown): Promise<RegistrationResponse> {
    const { email, displayName, password } = validateRegistration(body);
    const passwordHash = await hashPassword(password);
    try {
      const user = await this.db.user.create({
        data: { email, displayName, passwordHash },
        select: { id: true, email: true, displayName: true, createdAt: true },
      });
      return { user: { ...user, createdAt: user.createdAt.toISOString() } };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException();
      throw error;
    }
  }
}
