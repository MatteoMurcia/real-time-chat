import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { validateMessage } from '../src/messaging/validate-message.js';

test('validates message identity and Unicode limits without changing the body', () => {
  const input = { channelId: randomUUID(), clientMessageId: randomUUID(), body: '  Hello\n🌍 e\u0301 <script>  ' };
  assert.deepEqual(validateMessage(input), input);
  assert.equal(validateMessage({ ...input, body: '🌍'.repeat(2000) }).body.length, 4000);
  assert.equal(validateMessage({ ...input, clientMessageId: input.clientMessageId.toUpperCase() }).clientMessageId, input.clientMessageId);
  for (const value of [null, [], {}, { ...input, authorId: randomUUID() }, { ...input, channelId: 'bad' },
    { ...input, clientMessageId: 'bad' }, ...['', ' \n\t', 'x'.repeat(2001), '🌍'.repeat(2001), '\0', '\ud800'].map(body => ({ ...input, body }))]) {
    assert.throws(() => validateMessage(value), BadRequestException);
  }
});
