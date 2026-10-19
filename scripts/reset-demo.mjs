import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateResetConnection(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'db' || (url.port || '5432') !== '5432'
    || url.pathname !== '/chat_demo' || url.username !== 'demo_local' || !url.password || url.search || url.hash) throw new Error('Not the dedicated demo connection');
  return url.href;
}

export async function resetDemo(db, confirmation) {
  if (confirmation !== 'chat_demo') throw new Error('Explicit --confirm chat_demo is required');
  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(52710)`;
    const [target] = await tx.$queryRaw`SELECT datname::text AS database, current_user::text AS role,
      shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()`;
    if (target?.database !== 'chat_demo' || target.role !== 'demo_local' || target.marker !== 'real-time-chat:local-demo:v1') throw new Error('Demo initialization marker is missing or target differs');
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
    // No CASCADE: unexpected foreign-key dependencies must fail instead of deleting other tables.
    await tx.$executeRawUnsafe('TRUNCATE TABLE public."Message", public."Membership", public."Session", public."Channel", public."User"');
  }, { timeout: 10000 });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let db;
  try {
    const { values } = parseArgs({ options: { confirm: { type: 'string' } } });
    if (values.confirm !== 'chat_demo') throw new Error('Confirmation missing');
    const connection = validateResetConnection(process.env.DATABASE_URL);
    const { DatabaseService } = await import('../apps/api/dist-seed/src/database/database.service.js');
    db = new DatabaseService(connection);
    await resetDemo(db, values.confirm);
    process.stdout.write('Demo chat_demo cleared. Run seed before restarting API/web; previous sessions are invalid.\n');
  } catch {
    process.stderr.write('Demo reset refused or failed. Check the dedicated demo environment and explicit confirmation.\n');
    process.exitCode = 1;
  } finally {
    try { await db?.$disconnect(); } catch { process.stderr.write('Demo database cleanup failed.\n'); process.exitCode = 1; }
  }
}
