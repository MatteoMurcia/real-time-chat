import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { validateChannelId } from '../src/channels/channel-access.service.js';

test('accepts canonical channel UUIDs and rejects malformed identifiers', () => {
  const id = randomUUID();
  assert.equal(validateChannelId(id.toUpperCase()), id);
  for (const input of ['', 'not-a-uuid', `${id} `, `${id}/membership`, "' OR 1=1", '00000000-0000-0000-0000-000000000000']) {
    assert.throws(() => validateChannelId(input), BadRequestException);
  }
});
