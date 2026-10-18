import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../../src/database/database.service.js';

export async function createUserFixture(db: DatabaseService) {
  const user = await db.user.create({ data: {
    email: `${randomUUID()}@example.test`, displayName: 'Integration test', passwordHash: 'test-only-hash',
  } });
  return { user, session: { userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 86400000) } };
}
