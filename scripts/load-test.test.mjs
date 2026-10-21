import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadOptions, percentile, summarize } from './load-metrics.mjs';

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
