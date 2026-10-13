import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyCursor } from '../src/messaging/history-cursor.js';
import { syncQuery } from '../src/messaging/sync-query.js';

test('sync accepts snapshot boundaries including zero and exact BIGINT values', () => {
  const id = 'channel', cursor = (n: bigint) => historyCursor(id, n, n);
  assert.deepEqual(syncQuery(id, { after: cursor(0n) }), { after: 0n, until: null, limit: 50 });
  assert.deepEqual(syncQuery(id, { after: cursor(9007199254740993n), until: cursor(9223372036854775807n), limit: '100' }),
    { after: 9007199254740993n, until: 9223372036854775807n, limit: 100 });
  assert.deepEqual(syncQuery(id, { after: cursor(1n), until: cursor(1n), limit: '1' }), { after: 1n, until: 1n, limit: 1 });
});

test('sync rejects malformed, cross-channel, history-page and reversed boundaries', () => {
  const id = 'channel', cursor = historyCursor(id, 1n, 1n);
  for (const query of [null, [], {}, { after: '0' }, { after: [cursor] }, { after: cursor, until: [cursor] },
    { after: cursor, before: cursor }, { after: cursor, unknown: 'x' },
    ...['0', '01', '101', '-1', '1.5'].map(limit => ({ after: cursor, limit })), { after: cursor, limit: ['1'] },
    ...[cursor + '=', 'bad', 'x'.repeat(257), historyCursor('other', 1n, 1n), historyCursor(id, 1n, 2n),
      historyCursor(id, -1n, -1n), historyCursor(id, 9223372036854775808n, 9223372036854775808n)]
      .map(after => ({ after })), { after: cursor, until: historyCursor(id, 0n, 0n) }]) {
    assert.throws(() => syncQuery(id, query), { status: 400 });
  }
});
