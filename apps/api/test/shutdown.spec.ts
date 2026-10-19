import 'reflect-metadata';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DatabaseService } from '../src/database/database.service.js';
import { LiveController } from '../src/health/live.controller.js';
import { ReadyController } from '../src/health/ready.controller.js';
import { ErrorFilter } from '../src/http/error.filter.js';
import { httpDiagnostics } from '../src/logging/http-diagnostics.js';
import { ShutdownError, ShutdownState } from '../src/shutdown/shutdown-state.js';
import { configureShutdown } from '../src/shutdown/shutdown.js';
import { ChatGateway } from '../src/realtime/chat.gateway.js';
import type { SessionService } from '../src/identity/session.service.js';
import type { ChannelAccessService } from '../src/channels/channel-access.service.js';
import type { ConnectionsService } from '../src/realtime/connections.service.js';
import type { SendMessageService } from '../src/messaging/send-message.service.js';
import type { RateLimitService } from '../src/security/rate-limit.service.js';
import type { Server, Socket } from 'socket.io';
import type { IncomingMessage, ServerResponse } from 'node:http';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
let held = gate(), started = gate(), probe = async () => {}, dispose = () => {};
let completed = false, writes = 0;
@Controller()
class WorkController {
  @Get('held') async hold() { started.release(); await held.promise; completed = true; return { done: true }; }
  @Post('work') write() { writes++; return { done: true }; }
}
@Module({
  controllers: [WorkController, LiveController, ReadyController],
  providers: [ShutdownState, { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: DatabaseService, useValue: { checkReady: () => probe(), onModuleDestroy: () => dispose() } }],
})
class ShutdownTestModule {}

test('drain rejects new admissions, waits all admitted work and releases each operation once', async () => {
  const state = new ShutdownState(), first = state.enter(), second = state.enter();
  let drained = false;
  const closing = state.drain().then(() => { drained = true; });
  assert.equal(state.draining, true); assert.throws(() => state.enter(), ShutdownError);
  first(); first(); await Promise.resolve(); assert.equal(state.pending, 1); assert.equal(drained, false);
  second(); await closing; assert.equal(state.pending, 0);
  await state.drain(); assert.equal(state.pending, 0);
});

test('HTTP drain waits an aborted controller, rejects a late body and preserves health until disposal', async t => {
  held = gate(); started = gate(); completed = false; writes = 0;
  let disposed = 0, disposedEarly = false, probeCalls = 0;
  dispose = () => { disposed++; disposedEarly = !completed; };
  probe = async () => { probeCalls++; };
  const app = await NestFactory.create<NestExpressApplication>(ShutdownTestModule, { logger: false, bodyParser: false });
  const state = app.get(ShutdownState), bodyStarted = gate();
  app.setGlobalPrefix('api'); app.use(httpDiagnostics);
  app.use((req: { url: string }, _res: unknown, next: () => void) => { if (req.url === '/api/work') bodyStarted.release(); next(); });
  configureShutdown(app, state); app.useBodyParser('json');
  await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const abort = new AbortController();
  const pending = fetch(`${base}/api/held`, { signal: abort.signal }).then(() => 'completed', () => 'aborted');
  await started.promise; assert.equal(state.pending, 1);
  const late = request(`${base}/api/work`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  const lateResponse = new Promise<number>((resolve, reject) => {
    late.on('response', response => { response.resume(); resolve(response.statusCode!); }); late.on('error', reject);
  });
  t.after(async () => { abort.abort(); held.release(); late.destroy(); await state.close(app); });
  late.write('{"value":'); await bodyStarted.promise;
  const closing = state.close(app); assert.equal(state.close(app), closing); assert.equal(state.draining, true);
  const ready = await fetch(`${base}/api/health/ready`);
  assert.equal(ready.status, 503); assert.deepEqual(await ready.json(), { status: 'unavailable' });
  assert.equal(probeCalls, 0); assert.equal((await fetch(`${base}/api/health/live`)).status, 200);
  const rejected = await fetch(`${base}/api/work`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(rejected.status, 503); assert.equal(rejected.headers.get('retry-after'), '1');
  late.end('true}'); assert.equal(await lateResponse, 503); assert.equal(writes, 0);
  abort.abort(); assert.equal(await pending, 'aborted'); assert.equal(state.pending, 1); assert.equal(disposed, 0);
  held.release(); await closing;
  assert.equal(disposedEarly, false); assert.equal(disposed, 1); assert.equal(state.pending, 0);
});

test('a readiness probe admitted before drain cannot report ready after its database await', async t => {
  const checked = gate(), resume = gate();
  probe = async () => { checked.release(); await resume.promise; }; dispose = () => {};
  const app = await NestFactory.create<NestExpressApplication>(ShutdownTestModule, { logger: false });
  const state = app.get(ShutdownState);
  app.setGlobalPrefix('api'); configureShutdown(app, state);
  await app.listen(0, '127.0.0.1');
  t.after(async () => { resume.release(); await state.close(app); });
  const pending = fetch(`${await app.getUrl()}/api/health/ready`); await checked.promise;
  const closing = state.close(app); resume.release();
  const response = await pending; assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unavailable' }); await closing;
});

test('drain rejects new engines and closes raced authentication by transport without reopening work', async t => {
  const state = new ShutdownState(), checked = gate(), resume = gate();
  const authenticateSession = async () => { checked.release(); await resume.promise; return { id: 'session', user: { id: 'user' }, expiresAt: new Date(Date.now() + 60000) }; };
  const reserve = t.mock.fn(), add = t.mock.fn(), next = t.mock.fn(), close = t.mock.fn(), disconnect = t.mock.fn();
  const gateway = new ChatGateway({ authenticate: authenticateSession } as unknown as SessionService, 'http://127.0.0.1:8080',
    {} as DatabaseService, {} as ChannelAccessService, { add } as unknown as ConnectionsService,
    {} as SendMessageService, { reserveConnection: reserve } as unknown as RateLimitService, state);
  let namespace!: (socket: Socket, next: (error?: Error) => void) => Promise<void>;
  let engine!: (req: IncomingMessage, res: ServerResponse, next: (error?: Error) => void) => void;
  gateway.afterInit({ engine: { use: (callback: typeof engine) => { engine = callback; } }, use: (callback: typeof namespace) => { namespace = callback; } } as unknown as Server);
  const socket = { data: {}, request: { headers: { cookie: 'opaque-session' } }, conn: { close }, disconnect } as unknown as Socket;
  const authenticating = namespace(socket, next); await checked.promise;
  assert.equal(state.pending, 1); const draining = state.drain(); resume.release();
  await authenticating; await draining;
  assert.equal(reserve.mock.callCount(), 0); assert.equal(next.mock.callCount(), 0);
  assert.equal(close.mock.callCount(), 1); assert.equal(disconnect.mock.callCount(), 0);
  await gateway.handleConnection(socket);
  assert.equal(add.mock.callCount(), 0); assert.equal(close.mock.callCount(), 2); assert.equal(state.pending, 0);
  const response = {} as ServerResponse;
  const incoming = { url: '/socket.io/?EIO=4&transport=polling', headers: { origin: 'http://127.0.0.1:8080' } } as IncomingMessage;
  const rejected: (Error | undefined)[] = [];
  engine(incoming, response, error => rejected.push(error));
  assert.equal(rejected[0]?.message, 'Server shutting down');
  incoming.url += '&sid=existing-session'; engine(incoming, response, error => rejected.push(error));
  assert.equal(rejected[1], undefined);
});
