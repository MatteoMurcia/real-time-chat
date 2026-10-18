import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Controller, Get, HttpException, Logger, Module, Param, Post } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { isApiError } from '@real-time-chat/contracts';
import { ErrorFilter } from '../src/http/error.filter.js';
import { socketError } from '../src/realtime/socket-error.js';

const privateDetail = randomUUID();

@Controller('errors')
class ErrorsController {
  @Get(':status')
  fail(@Param('status') status: string) {
    if (status === 'unexpected') throw new Error(privateDetail);
    throw new HttpException({ message: 'private detail', stack: 'private stack' }, Number(status));
  }

  @Post()
  accept() { return { ok: true }; }
}

@Module({ controllers: [ErrorsController], providers: [{ provide: APP_FILTER, useClass: ErrorFilter }] })
class ErrorsTestModule {}

test('HTTP errors use safe codes, fresh server IDs and no internal details', async t => {
  const logs: unknown[] = [];
  t.mock.method(Logger.prototype, 'error', (message: unknown) => logs.push(message));
  const app = await NestFactory.create(ErrorsTestModule, { logger: false });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const ids = new Set<string>();
  for (const [status, code] of [[400, 'VALIDATION_ERROR'], [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [409, 'CONFLICT'], [429, 'RATE_LIMITED'],
    [500, 'INTERNAL_ERROR'], [503, 'INTERNAL_ERROR'], ['unexpected', 'INTERNAL_ERROR']] as const) {
    const response = await fetch(`${base}/errors/${status}`, { headers: { 'X-Request-Id': 'spoofed' } });
    assert.equal(response.status, code === 'INTERNAL_ERROR' ? 500 : status);
    const body: unknown = await response.json();
    assert.ok(isApiError(body));
    assert.equal(body.code, code);
    assert.deepEqual(Object.keys(body).sort(), ['code', 'message', 'requestId']);
    assert.doesNotMatch(JSON.stringify(body), /private|stack|password|spoofed/);
    assert.equal(JSON.stringify(body).includes(privateDetail), false);
    assert.equal(response.headers.get('x-request-id'), body.requestId);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(ids.has(body.requestId), false);
    ids.add(body.requestId);
  }
  const missing = await fetch(`${base}/missing?token=private`);
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.ok(isApiError(missingBody));
  assert.equal(missingBody.code, 'NOT_FOUND');
  const malformed = await fetch(`${base}/errors`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"private":',
  });
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.json();
  assert.ok(isApiError(malformedBody));
  assert.equal(malformedBody.code, 'VALIDATION_ERROR');
  assert.doesNotMatch(JSON.stringify(malformedBody), /private/);
  const socketFailure = socketError(new Error(privateDetail));
  assert.equal(socketFailure.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(socketFailure).includes(privateDetail), false);
  assert.ok(logs.length > 0);
  assert.equal(JSON.stringify(logs).includes(privateDetail), false);
  for (const log of logs) {
    assert.ok(log && typeof log === 'object');
    assert.deepEqual(Object.keys(log).sort(), ['code', 'requestId']);
    assert.ok('code' in log && log.code === 'INTERNAL_ERROR');
    assert.ok('requestId' in log && typeof log.requestId === 'string' && /^[a-f0-9-]{36}$/.test(log.requestId));
  }
});
