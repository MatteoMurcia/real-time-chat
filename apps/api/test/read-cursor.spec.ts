import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { validateReadSequence } from '../src/activity/read-cursor.service.js';

test('read boundaries are canonical nonnegative PostgreSQL BIGINT strings without forged fields', () => {
  for (const value of ['0', '1', '9007199254740993', '9223372036854775807']) {
    assert.equal(validateReadSequence({ lastReadSequence: value }), BigInt(value));
  }
  for (const body of [null, [], {}, { lastReadSequence: '1', userId: 'forged' },
    ...[1, 1n, true, null, [], {}, '', '01', '-1', '+1', ' 1', '1 ', '1\n', '1.0', '1e3', '9223372036854775808', '9'.repeat(1000)].map(lastReadSequence => ({ lastReadSequence }))]) {
    assert.throws(() => validateReadSequence(body), BadRequestException);
  }
});
