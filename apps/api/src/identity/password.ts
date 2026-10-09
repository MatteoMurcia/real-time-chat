import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = (password: string, salt: Buffer) => promisify(argon2)('argon2id', {
  message: password, nonce: salt, memory: 19456, passes: 2, parallelism: 1, tagLength: 32,
});
const base64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `$argon2id$v=19$m=19456,t=2,p=1$${base64(salt)}$${base64(await derive(password, salt))}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  // Accept only the bounded parameters emitted by this application.
  const match = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/.exec(encoded);
  if (!match) throw new Error('Unsupported password hash');
  return timingSafeEqual(await derive(password, Buffer.from(match[1]!, 'base64')), Buffer.from(match[2]!, 'base64'));
}
