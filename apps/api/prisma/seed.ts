import { DatabaseService } from '../src/database/database.service.js';
import { seedDemo } from './demo-seed.js';

let db: DatabaseService | undefined;
try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  db = new DatabaseService(process.env.DATABASE_URL);
  await seedDemo(db, process.env);
  process.stdout.write('Demo ready: 2 accounts, 2 channels, 111 sample messages. Existing data preserved.\n');
} catch {
  process.stderr.write('Demo seed failed. Check local credentials and reserved demo identities; no private details are logged.\n');
  process.exitCode = 1;
} finally {
  try { await db?.$disconnect(); }
  catch { process.stderr.write('Demo database cleanup failed.\n'); process.exitCode = 1; }
}
