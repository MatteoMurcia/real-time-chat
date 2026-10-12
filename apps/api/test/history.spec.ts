import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyCursor, historyQuery } from '../src/messaging/history-cursor.js';

test('history cursors bind canonical BIGINT boundaries to a channel and bound page size', () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const cursor = historyCursor(id, 9007199254740993n, 9223372036854775807n);
  assert.deepEqual(historyQuery(id, { before: cursor, limit: '100' }), { limit: 100, before: { sequence: 9007199254740993n, snapshot: 9223372036854775807n } });
  assert.deepEqual(historyQuery(id, {}), { limit: 50, before: null });
  for (const query of [null, [], { after: cursor }, { limit: ['5'] }, { limit: '01' }, { limit: '101' }, { limit: '-1' },
    { before: cursor + '=' }, { before: 'bad' }, { before: [cursor] }, { before: historyCursor('other', 1n, 2n) },
    { before: historyCursor(id, 0n, 0n) }, { before: historyCursor(id, 3n, 2n) }, { before: historyCursor(id, 1n, 9223372036854775808n) }]) {
    assert.throws(() => historyQuery(id, query), { status: 400 });
  }
});
