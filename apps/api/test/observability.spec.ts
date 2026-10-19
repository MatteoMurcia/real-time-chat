import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Controller, Get, Logger, Module, Post } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DatabaseService } from '../src/database/database.service.js';
import { ReadyController } from '../src/health/ready.controller.js';
import { LiveController } from '../src/health/live.controller.js';
import { ErrorFilter } from '../src/http/error.filter.js';
import { httpDiagnostics } from '../src/logging/http-diagnostics.js';
import type { Diagnostic } from '../src/logging/logger.js';
import { socketError } from '../src/realtime/socket-error.js';
import { ShutdownState } from '../src/shutdown/shutdown-state.js';

const secret = `private-${randomUUID()}`;
let unavailable = false;
@Controller('probe')
class ProbeController {
  @Get('failure/:id') fail() { throw new Error(secret); }
  @Post() accept() { return { ok: true }; }
}
@Module({
  controllers: [ProbeController, ReadyController, LiveController],
  providers: [ShutdownState, { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: DatabaseService, useValue: { checkReady: async () => { if (unavailable) throw new Error(secret); } } }],
})
class DiagnosticTestModule {}

test('HTTP correlation covers success, parsing, private paths and dependency failure without exposing data', async t => {
  const records: Diagnostic[] = [];
  for (const method of ['log', 'warn', 'error'] as const) t.mock.method(Logger.prototype, method, (record: Diagnostic) => { if (record?.event) records.push(record); });
  const app = await NestFactory.create<NestExpressApplication>(DiagnosticTestModule, { logger: false, bodyParser: false });
  t.after(() => app.close());
  app.use(httpDiagnostics); app.useBodyParser('json'); app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const ids = new Set<string>();
  for (const [path, status, options] of [
    ['/api/probe', 201, { method: 'POST', body: JSON.stringify({ password: secret }), headers: { 'content-type': 'application/json' } }],
    [`/api/probe/failure/${secret}?token=${secret}`, 500, {}],
    [`/api/${secret}?token=${secret}`, 404, {}],
    ['/api/probe', 404, { method: 'PROPFIND' }],
    ['/api/probe', 400, { method: 'POST', body: `{"password":"${secret}",`, headers: { 'content-type': 'application/json' } }],
  ] as const) {
    const response = await fetch(`${base}${path}`, { ...options, headers: { ...options.headers,
      cookie: `chat_session=${secret}`, authorization: `Bearer ${secret}`, 'x-request-id': secret, 'x-csrf-token': secret } });
    const body = await response.json();
    assert.equal(response.status, status);
    const id = response.headers.get('x-request-id')!;
    assert.match(id, /^[a-f0-9-]{36}$/); assert.equal(ids.has(id), false); ids.add(id);
    if (status >= 400) assert.equal(body.requestId, id);
    const record = records.find(record => record.requestId === id)!;
    assert.ok(record); assert.equal(record.event, 'http.request'); assert.equal(record.status, status);
    assert.ok(record.durationMs! >= 0);
    if (options.method === 'PROPFIND') assert.equal(record.method, 'OTHER');
    if (status === 500) { assert.equal(record.route, '/api/probe/failure/:id'); assert.equal(record.code, 'INTERNAL_ERROR'); }
    if (status === 404) assert.equal(record.route, '*path');
    if (status === 400) assert.equal(record.route, 'unmatched');
    assert.equal(JSON.stringify(body).includes(secret), false);
  }
  assert.equal((await fetch(`${base}/api/health/ready`)).status, 200);
  unavailable = true;
  try {
    const response = await fetch(`${base}/api/health/ready`);
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { status: 'unavailable' });
    assert.equal(records.find(record => record.requestId === response.headers.get('x-request-id'))?.code, 'DATABASE_UNAVAILABLE');
    const live = await fetch(`${base}/api/health/live`);
    assert.equal(live.status, 200); assert.deepEqual(await live.json(), { status: 'ok' });
  } finally { unavailable = false; }
  assert.equal((await fetch(`${base}/api/health/ready`)).status, 200);
  const failed = socketError(new Error(secret), { clientMessageId: secret, channelId: secret, stage: 'persist' });
  const failure = records.find(record => record.requestId === failed.requestId)!;
  assert.equal(failure.code, 'INTERNAL_ERROR'); assert.equal(failure.stage, 'persist');
  assert.equal(failure.clientMessageId, undefined); assert.equal(failure.channelId, undefined);
  assert.equal(JSON.stringify(records).includes(secret), false);
});

test('the built-in JSON logger emits a single parseable allowlisted record', () => {
  const requestId = randomUUID(), clientMessageId = randomUUID();
  const source = `import { ConsoleLogger, Logger } from '@nestjs/common';
    import { diagnostic } from ${JSON.stringify(new URL('../src/logging/logger.js', import.meta.url).href)};
    Logger.overrideLogger(new ConsoleLogger({json:true,colors:false}));
    diagnostic(${JSON.stringify({ event: 'message.send', requestId, clientMessageId: clientMessageId.toUpperCase(), body: secret, cookie: secret, password: secret, error: { message: secret } })});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const record = JSON.parse(result.stdout.trim());
  assert.equal(record.message.event, 'message.send'); assert.equal(record.message.requestId, requestId);
  assert.equal(record.message.clientMessageId, clientMessageId);
  assert.deepEqual(Object.keys(record.message).sort(), ['clientMessageId', 'event', 'requestId']);
  assert.equal(result.stdout.includes(secret), false);
});
