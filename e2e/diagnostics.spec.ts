import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { expect, test } from './fixtures.js';

function isolatedStack() {
  const project = process.env.E2E_COMPOSE_PROJECT ?? '';
  expect(['ci-chat', 'chat-e2e', 'handshake-verification']).toContain(project);
  for (const service of ['api', 'web', 'db']) {
    const result = spawnSync('docker', ['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', `${project}-${service}-1`], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0); expect(result.stdout.trim()).toBe(project);
  }
  return (action: 'logs' | 'pause' | 'unpause' | 'stop' | 'start', service: 'api' | 'web' | 'db') => {
    const result = spawnSync('docker', [action, ...(action === 'stop' ? ['--time', '1'] : []), `${project}-${service}-1`], { encoding: 'utf8', timeout: 15000 });
    expect(result.status, `Isolated ${service} ${action} must succeed`).toBe(0);
    return `${result.stdout}${result.stderr}`;
  };
}

function diagnostics(text: string): Record<string, unknown>[] {
  return text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line).message)
    .filter(message => message && typeof message === 'object' && typeof message.event === 'string');
}

test('correlates HTTP and send outcomes across API and proxy without logging private values', async ({ context, chatAccount }) => {
  const docker = isolatedStack(), { channel, sender } = chatAccount;
  const secret = `body-${randomUUID()}`, input = { channelId: channel.id, clientMessageId: randomUUID(), body: secret };
  const send = (value: unknown) => sender.timeout(5000).emitWithAck('message:send', value);
  const first = await send(input); expect(first.ok).toBe(true);
  expect(await send(input)).toEqual(first);
  const conflict = await send({ ...input, body: `${secret}-conflict` });
  expect(conflict).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  const invalid = await send({ ...input, clientMessageId: secret });
  expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  const response = await context.request.get(`/api/missing?token=${secret}`, {
    headers: { 'x-request-id': secret, authorization: `Bearer ${secret}`, 'x-csrf-token': secret },
  });
  expect(response.status()).toBe(404);
  const failure = await response.json(), requestId = response.headers()['x-request-id'];
  expect(failure.requestId).toBe(requestId); expect(requestId).not.toBe(secret);
  const origin = process.env.E2E_BASE_URL!;
  const csrf = (await (await context.request.get('/api/auth/session/csrf', { headers: { origin } })).json()).csrfToken;
  expect((await context.request.delete(`/api/channels/${channel.id}/membership`, { headers: { origin, 'x-csrf-token': csrf } })).status()).toBe(200);
  const forbidden = await send(input);
  expect(forbidden).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  const logs = docker('logs', 'api'), records = diagnostics(logs);
  expect(records.find(record => record.requestId === requestId)).toMatchObject({ event: 'http.request', status: 404, code: 'NOT_FOUND' });
  const sends = records.filter(record => record.clientMessageId === input.clientMessageId);
  expect(sends.map(record => record.outcome ?? record.code)).toEqual(['created', 'duplicate', 'CONFLICT', 'FORBIDDEN']);
  expect(new Set(sends.map(record => record.requestId)).size).toBe(4);
  expect(records.find(record => record.requestId === conflict.error.requestId)).toMatchObject({ clientMessageId: input.clientMessageId, stage: 'persist' });
  expect(records.find(record => record.requestId === invalid.error.requestId)?.clientMessageId).toBeUndefined();
  const proxy = docker('logs', 'web').trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  expect(proxy.find(record => record.apiRequestId === requestId)).toMatchObject({ status: '404' });
  const privateValues = [secret, csrf, 'a unique protocol passphrase', ...(await context.cookies()).map(cookie => cookie.value)];
  for (const text of [logs, JSON.stringify(proxy)]) for (const value of privateValues) expect(text.includes(value)).toBe(false);
});

test('bounds unresponsive database probes, keeps liveness and recovers failed sends after database return', async ({ context, chatAccount }) => {
  test.setTimeout(60000);
  const docker = isolatedStack(), { channel, sender } = chatAccount;
  const ready = () => context.request.get('/api/health/ready', { timeout: 6000 });
  expect((await ready()).status()).toBe(200);
  try {
    docker('pause', 'db');
    const started = performance.now();
    const probes = Promise.all(Array.from({ length: 4 }, ready));
    const live = await context.request.get('/api/health/live', { timeout: 2000 });
    expect(live.status()).toBe(200); expect(await live.json()).toEqual({ status: 'ok' });
    for (const response of await probes) {
      expect(response.status()).toBe(503); expect(await response.json()).toEqual({ status: 'unavailable' });
    }
    expect(performance.now() - started).toBeLessThan(4500);
  } finally { docker('unpause', 'db'); }
  await expect.poll(async () => (await ready()).status(), { timeout: 10000 }).toBe(200);
  const input = { channelId: channel.id, clientMessageId: randomUUID(), body: `database-failure-${randomUUID()}` };
  try {
    docker('stop', 'db');
    expect((await ready()).status()).toBe(503);
    expect((await context.request.get('/api/health/live')).status()).toBe(200);
    const failure = await sender.timeout(10000).emitWithAck('message:send', input);
    expect(failure).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    const logs = docker('logs', 'api');
    expect(diagnostics(logs).find(record => record.requestId === failure.error.requestId))
      .toMatchObject({ code: 'INTERNAL_ERROR', clientMessageId: input.clientMessageId, stage: 'authorize' });
    expect(logs.includes(input.body)).toBe(false);
  } finally { docker('start', 'db'); }
  await expect.poll(async () => (await ready()).status(), { timeout: 15000 }).toBe(200);
  const saved = await sender.timeout(5000).emitWithAck('message:send', input);
  expect(saved.ok).toBe(true);
  const history = await context.request.get(`/api/channels/${channel.id}/messages`);
  expect(history.ok()).toBe(true); expect((await history.json()).items).toEqual([saved.data]);
});
