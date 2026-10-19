import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import type { SendMessageAck } from '@real-time-chat/contracts/messages';
import { DatabaseService } from '../../src/database/database.service.js';
import { ChannelsService } from '../../src/channels/channels.service.js';
import { SessionService } from '../../src/identity/session.service.js';
import { hashPassword } from '../../src/identity/password.js';

function start(databaseUrl: string, mode = 'normal') {
  const child = fork(fileURLToPath(new URL('../fixtures/shutdown-process.js', import.meta.url)), [mode], {
    execArgv: [], // The integration preload rebuilds/removes DATABASE_URL; this child owns its isolated URL.
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, PORT: '3000', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.resume(); child.stderr?.resume();
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise<string>((resolve, reject) => {
    const deadline = globalThis.setTimeout(() => reject(new Error('Shutdown child did not start')), 8000);
    child.once('error', () => { clearTimeout(deadline); reject(new Error('Shutdown child could not start')); });
    child.once('exit', () => { clearTimeout(deadline); reject(new Error('Shutdown child exited before listening')); });
    child.once('message', message => {
      clearTimeout(deadline);
      const data = message as { event: string; url: string };
      if (data.event === 'listening') resolve(data.url); else reject(new Error('Invalid startup phase'));
    });
  });
  return { child, exited, ready };
}

async function within<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = globalThis.setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function verifyShutdown(app: INestApplication, db: DatabaseService, databaseUrl: string): Promise<void> {
  assert.equal(process.platform, 'linux', 'Process signal verification runs in the Linux integration container');
  const password = 'shutdown integration passphrase', suffix = randomUUID();
  const user = await db.user.create({ data: { email: `shutdown-${suffix}@example.test`, displayName: 'Shutdown reader', passwordHash: await hashPassword(password) } });
  const cookie = (await app.get(SessionService).login({ email: user.email, password })).cookie.split(';')[0]!;
  const origin = 'http://127.0.0.1:8080';
  const children: ReturnType<typeof start>[] = [], sockets: Socket[] = [];
  const connect = async (url: string) => {
    const socket = io(url, { autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { origin, cookie } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    return socket;
  };
  try {
    for (const mode of ['commit', 'rollback', 'stall', 'leak']) {
      const channel = (await app.get(ChannelsService).create(user.id, { name: `Shutdown ${mode} ${suffix}`, slug: `shutdown-${mode}-${suffix.slice(0, 8)}` })).channel;
      const input = { channelId: channel.id, clientMessageId: randomUUID(), body: `Shutdown ${mode}` };
      const running = start(databaseUrl, mode); children.push(running);
      const url = await running.ready, sender = await connect(url);
      let committedId: string | undefined;
      let release!: () => void, entered!: (pid: number) => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const locked = new Promise<number>(resolve => { entered = resolve; });
      let lock: Promise<unknown> | undefined;
      if (mode === 'commit' || mode === 'rollback') {
        await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_shutdown_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW."channelId" = '${channel.id}'::uuid THEN
            PERFORM pg_advisory_xact_lock(hashtextextended('${channel.id}', 0));
            ${mode === 'rollback' ? "RAISE EXCEPTION 'intentional shutdown rollback';" : ''}
          END IF; RETURN NEW; END $$`);
        await db.$executeRawUnsafe('CREATE CONSTRAINT TRIGGER test_shutdown_gate AFTER INSERT ON "Message" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_shutdown_gate()');
        lock = db.$transaction(async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${channel.id}, 0))`;
          const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          entered(backend!.pid); await held;
        }, { timeout: 15000 });
      }
      const barrier = lock ? await Promise.race([locked, lock.then(() => { throw new Error('Database barrier ended before acquisition'); })]) : undefined;
      const heldSend = mode === 'stall' ? new Promise<void>((resolve, reject) => running.child.once('message', message => {
        if ((message as { event?: string }).event === 'send-held') resolve(); else reject(new Error('Unexpected stall phase'));
      })) : undefined;
      const replies: SendMessageAck[] = [];
      const result = sender.timeout(12000).emitWithAck('message:send', input).then((ack: SendMessageAck) => { replies.push(ack); return ack; }, () => undefined);
      try {
        if (lock) {
          const pid = barrier!;
          let blocked = false; const deadline = Date.now() + 3000;
          while (!blocked && Date.now() < deadline) {
            const [row] = await db.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))
            ) AS blocked`;
            blocked = row!.blocked; if (!blocked) await setTimeout(10);
          }
          assert.equal(blocked, true, 'the real deferred commit must wait at its database barrier');
          assert.deepEqual(replies, []); assert.equal(await db.message.count({ where: { channelId: channel.id } }), 0);
        } else if (heldSend) await within(Promise.race([heldSend, result.then(() => { throw new Error('Send ended before the stall barrier'); })]), 3000, 'Send never reached the stall barrier');
        else assert.equal((await result)?.ok, true);
        const before = Date.now(); assert.equal(running.child.kill('SIGTERM'), true);
        if (mode !== 'leak') {
          let response: Response | undefined;
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline && response?.status !== 503) { response = await fetch(`${url}/api/health/ready`); if (response.status !== 503) await setTimeout(10); }
          assert.equal(response?.status, 503, 'readiness must withdraw while admitted work is still pending');
          assert.ok(response);
          assert.deepEqual(await response.json(), { status: 'unavailable' });
          assert.equal((await fetch(`${url}/api/health/live`)).status, 200);
          assert.equal((await fetch(`${url}/api/channels`, { headers: { cookie } })).status, 503);
          const rejected = await sender.timeout(3000).emitWithAck('message:send', { ...input, clientMessageId: randomUUID() });
          assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'INTERNAL_ERROR');
          assert.equal(replies.some(ack => ack.ok), false);
          assert.equal(running.child.kill('SIGTERM'), true); // Repeated signals must not bypass or extend draining.
        }
        release(); await lock;
        const exit = await within(running.exited, 10000, 'Child exceeded its shutdown budget');
        assert.equal(exit.signal, null); assert.equal(exit.code, mode === 'stall' || mode === 'leak' ? 1 : 0, `${mode} must exit with the expected status`);
        assert.ok(Date.now() - before < 10000, 'process shutdown must remain inside its fixed budget');
        await result;
        const count = mode === 'commit' || mode === 'leak' ? 1 : 0;
        assert.equal(await db.message.count({ where: { channelId: channel.id } }), count);
        committedId = (await db.message.findFirst({ where: { channelId: channel.id } }))?.id;
        if (mode === 'rollback' || mode === 'stall') assert.equal(replies.some(ack => ack.ok), false);
      } finally {
        release(); await lock;
        if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGKILL');
        await running.exited;
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_shutdown_gate ON "Message"');
      }
      const restarted = start(databaseUrl); children.push(restarted);
      try {
        const retry = await connect(await restarted.ready);
        const ack: SendMessageAck = await retry.timeout(3000).emitWithAck('message:send', input);
        assert.equal(ack.ok, true); if (!ack.ok) throw new Error('Restart retry failed');
        if (committedId) assert.equal(ack.data.id, committedId, 'retry must recover the original committed row');
        assert.equal(await db.message.count({ where: { channelId: channel.id } }), 1);
        assert.equal((await db.message.findUniqueOrThrow({ where: { id: ack.data.id } })).clientMessageId, input.clientMessageId);
      } finally { restarted.child.kill('SIGTERM'); assert.deepEqual(await within(restarted.exited, 10000, 'Restarted child exceeded its shutdown budget'), { code: 0, signal: null }); }
    }
  } finally {
    for (const socket of sockets) socket.disconnect();
    for (const process of children) if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGKILL');
    await Promise.all(children.map(process => process.exited));
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_shutdown_gate ON "Message"');
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_shutdown_gate()');
    await db.message.deleteMany({ where: { authorId: user.id } });
    await db.membership.deleteMany({ where: { userId: user.id } });
    await db.channel.deleteMany({ where: { createdBy: user.id } });
    await db.session.deleteMany({ where: { userId: user.id } }); await db.user.delete({ where: { id: user.id } });
  }
}
