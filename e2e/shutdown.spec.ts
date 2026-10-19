import { spawn, spawnSync } from 'node:child_process';
import type { PublicMessage, SendMessageRequest } from '@real-time-chat/contracts/messages';
import { expect, test } from './fixtures.js';

test('drains a real commit and recovers a lost confirmation after the API container restarts', async ({ page, context, chatAccount }) => {
  test.setTimeout(60000);
  const project = process.env.E2E_COMPOSE_PROJECT ?? '';
  expect(['ci-chat', 'chat-e2e', 'handshake-verification']).toContain(project);
  const docker = (...args: string[]) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 15000 });
    expect(result.status, `Docker ${args[0]} must succeed`).toBe(0);
    return result.stdout.trim();
  };
  const api = `${project}-api-1`, db = `${project}-db-1`;
  for (const container of [api, db]) {
    expect(docker('inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', container)).toBe(project);
  }
  const user = docker('exec', db, 'printenv', 'POSTGRES_USER'), database = docker('exec', db, 'printenv', 'POSTGRES_DB');
  const psql = ['exec', '-i', db, 'psql', '-U', user, '-d', database, '-Atq', '-v', 'ON_ERROR_STOP=1'];
  const sql = (statement: string) => docker(...psql, '-c', statement);
  const { channel, sender } = chatAccount;
  let input: SendMessageRequest | undefined, forward: (() => void) | undefined;
  let upgraded = false, connections = 0, successfulAcks = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**/socket.io/**', socket => {
    const first = ++connections === 1, server = socket.connectToServer(), acks = new Set<string>();
    socket.onMessage(frame => {
      if (frame === '5') upgraded = true;
      const match = typeof frame === 'string' && /^42(\d+)(\[.*)$/.exec(frame);
      if (match) {
        const [event, request] = JSON.parse(match[2]!) as [string, SendMessageRequest];
        if (event === 'message:send' && first) {
          acks.add(match[1]!);
          if (!input) { input = request; forward = () => server.send(frame); return; }
        }
      }
      server.send(frame);
    });
    server.onMessage(frame => {
      const ack = typeof frame === 'string' && /^43(\d+)(\[.*)$/.exec(frame);
      if (ack && acks.has(ack[1]!)) {
        if (JSON.parse(ack[2]!)[0]?.ok) successfulAcks++;
        return; // Lose the original confirmation at the client boundary, after the real commit.
      }
      const event = typeof frame === 'string' && /^42(\[.*)$/.exec(frame);
      if (first && event) {
        const [name, message] = JSON.parse(event[1]!) as [string, PublicMessage];
        if (name === 'message:created' && message.clientMessageId === input?.clientMessageId) return;
      }
      socket.send(frame);
    });
  });
  await page.goto('/workspace');
  await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
  await expect.poll(() => upgraded).toBe(true);
  await page.getByRole('button', { name: `Open chat ${channel.name}`, exact: true }).click();
  await expect(page.getByText('Live conversation ready.', { exact: true })).toBeVisible();
  await expect(page.getByText('Recovering missed messages…', { exact: true })).toHaveCount(0);
  let restarted = false;
  await page.route('**/api/channels/*/messages/sync?*', route => restarted ? route.continue() : route.abort('failed'));
  await page.getByLabel('Message', { exact: true }).fill('Committed while shutting down');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => input).toBeTruthy();
  const key = input!.clientMessageId;
  const gate = spawn('docker', psql, { stdio: ['pipe', 'pipe', 'pipe'] });
  const gateExit = new Promise<number | null>(resolve => gate.once('exit', resolve));
  let output = ''; gate.stdout.on('data', chunk => { output += chunk.toString(); }); gate.stderr.resume();
  let signalled = false;
  try {
    sql(`CREATE FUNCTION test_shutdown_browser_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."clientMessageId" = '${key}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtextextended('${key}', 0)); END IF;
      RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER test_shutdown_browser_gate AFTER INSERT ON "Message" DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION test_shutdown_browser_gate()`);
    gate.stdin.write(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('${key}', 0)); SELECT 'locked:' || pg_backend_pid();\n`);
    await expect.poll(() => /locked:\d+/.test(output)).toBe(true);
    const pid = /locked:(\d+)/.exec(output)![1]!;
    forward!();
    await expect.poll(() => sql(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid)))`)).toBe('t');
    expect(sql(`SELECT count(*) FROM "Message" WHERE "clientMessageId"='${key}'::uuid`)).toBe('0');
    expect(successfulAcks).toBe(0);
    docker('kill', '--signal=TERM', api); signalled = true;
    await expect.poll(async () => (await context.request.get('/api/health/ready')).status()).toBe(503);
    expect((await context.request.get('/api/health/live')).status()).toBe(200);
    expect((await context.request.get('/api/channels')).status()).toBe(503);
    const denied = await sender.timeout(2000).emitWithAck('message:send', input);
    expect(denied).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(successfulAcks).toBe(0);
    gate.stdin.end('COMMIT;\n'); expect(await gateExit).toBe(0);
    expect(docker('wait', api)).toBe('0');
    const id = sql(`SELECT id FROM "Message" WHERE "clientMessageId"='${key}'::uuid`);
    expect(id).toMatch(/^[\da-f-]{36}$/);
    docker('start', api); restarted = true;
    await expect.poll(async () => (await context.request.get('/api/health/ready')).status(), { timeout: 15000 }).toBe(200);
    await expect.poll(() => connections).toBeGreaterThan(1);
    await expect(page.getByText('Live connection established.', { exact: true })).toBeVisible();
    const log = page.getByRole('log', { name: 'Conversation messages' });
    await expect(log.locator('[data-message-id]')).toHaveCount(1);
    await expect(log.locator('[data-message-id]')).toHaveAttribute('data-message-id', id);
    await expect(log.locator('.outgoing')).toHaveCount(0);
    await new Promise<void>((resolve, reject) => { sender.once('connect', resolve); sender.once('connect_error', reject); sender.connect(); });
    expect(await sender.timeout(3000).emitWithAck('message:send', input)).toMatchObject({ ok: true, data: { id, clientMessageId: key } });
    expect(sql(`SELECT count(*) FROM "Message" WHERE "clientMessageId"='${key}'::uuid`)).toBe('1');
    expect(errors).toEqual([]);
  } finally {
    if (!gate.stdin.destroyed) gate.stdin.end('ROLLBACK;\n');
    if (gate.exitCode === null) gate.kill();
    await gateExit;
    sql('DROP TRIGGER IF EXISTS test_shutdown_browser_gate ON "Message"; DROP FUNCTION IF EXISTS test_shutdown_browser_gate()');
    if (signalled) docker('start', api);
  }
});
