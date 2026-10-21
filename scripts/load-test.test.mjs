import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadOptions, percentile, summarize, validateLocalDocker, deliveryAudit, messageFingerprint } from './load-metrics.mjs';

test('delivery detects extra broadcasts even when total received equals the expected count', () => {
  assert.deepEqual(deliveryAudit([new Map([['one', 'good']]), new Map([['extra', 'good']])], new Map([['one', 'good']])),
    { expected: 2, received: 2, missing: 1, unacknowledged: 1, mismatched: 0 });
  assert.deepEqual(deliveryAudit([new Map([['one', 'bad']])], new Map([['one', 'good']])),
    { expected: 1, received: 1, missing: 0, unacknowledged: 0, mismatched: 1 });
});

test('event fingerprints cover canonical payload fields, independent of object key order', () => {
  const message = { id: 'id', channelId: 'channel', clientMessageId: 'client', sequence: '1', body: 'hello', author: { id: 'user', displayName: 'User' }, createdAt: '2026-10-21T00:00:00Z' };
  const signature = messageFingerprint(message);
  assert.equal(messageFingerprint({ ...message, author: { displayName: 'User', id: 'user' } }), signature);
  for (const change of [{ body: 'wrong' }, { sequence: '2' }, { clientMessageId: 'wrong' }, { author: { id: 'other', displayName: 'User' } }]) {
    assert.notEqual(messageFingerprint({ ...message, ...change }), signature);
  }
});

test('load refuses remote Docker transports before provisioning any resources', () => {
  for (const value of ['unix:///var/run/docker.sock', 'npipe:////./pipe/dockerDesktopLinuxEngine']) assert.doesNotThrow(() => validateLocalDocker(value));
  for (const value of [undefined, 'ssh://server', 'tcp://127.0.0.1:2375', 'unix://server/run/docker.sock', 'npipe:////server/pipe/docker', 'unix:///socket?override=1']) assert.throws(() => validateLocalDocker(value));
});

test('load parameters are bounded and reject unknown flags, incomplete samples and excessive connections', () => {
  assert.deepEqual(loadOptions([]), { users: 8, connections: 2, rate: 1, seconds: 30, warmup: 5 });
  assert.equal(loadOptions(['--users', '4', '--connections', '3', '--rate', '0.5']).rate, .5);
  for (const args of [['--url', 'http://remote'], ['--users', '0'], ['--users', '1.5'], ['--connections', '6'],
    ['--users', '50', '--connections', '5'], ['--rate', 'NaN'], ['--rate', '4'], ['--seconds', '121'],
    ['--seconds', '5', '--rate', '.1'], ['--warmup', '-1'], ['--users']]) assert.throws(() => loadOptions(args));
});

test('nearest-rank percentiles preserve small samples, null for none, and do not mutate observations', () => {
  const values = [100, 2, 5, 10, 3];
  assert.equal(percentile(values, .5), 5); assert.equal(percentile(values, .95), 100);
  assert.equal(percentile([], .95), null); assert.equal(percentile([7], .95), 7);
  assert.deepEqual(values, [100, 2, 5, 10, 3]);
});

test('rejections and scheduling misses cannot disappear from reported success rates', () => {
  const report = summarize({ planned: 10, sent: 8, latencyMs: [4, 7, 10, 11, 12, 30], errors: { RATE_LIMITED: 2 }, lagMs: [1, 3], elapsedMs: 2000 });
  assert.equal(report.acknowledged, 6); assert.equal(report.errorRate, .25);
  assert.equal(report.skipped, 2); assert.equal(report.unsuccessfulScheduledRate, .4);
  assert.equal(report.offeredRps, 4); assert.equal(report.acknowledgedRps, 3);
  assert.deepEqual(report.ackLatencyMs, { p50: 10, p95: 30 });
});
