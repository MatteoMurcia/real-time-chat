import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorCodes, isApiError } from '../dist/errors.js';

test('accepts each public code with a message and server UUID', () => {
  for (const code of errorCodes) {
    assert.equal(isApiError({ code, message: 'Public message', requestId: 'e3028dab-3a9d-4b02-9e28-d3b645f6a583' }), true);
  }
});

test('rejects malformed or unknown responses at the HTTP boundary', () => {
  const valid = { code: 'NOT_FOUND', message: 'Not found', requestId: 'e3028dab-3a9d-4b02-9e28-d3b645f6a583' };
  for (const invalid of [null, [], 'proxy error', {}, { ...valid, code: 'UNKNOWN' },
    { ...valid, message: [] }, { ...valid, message: '' }, { ...valid, requestId: 'untrusted\nheader' }]) {
    assert.equal(isApiError(invalid), false);
  }
});
