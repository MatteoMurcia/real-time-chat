import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { validateChannel, validateChannelPage } from '../src/channels/channels.service.js';

test('normalizes channel names and rejects invalid fields or forged identity', () => {
  assert.deepEqual(validateChannel({ name: '  Cafe\u0301   team ', slug: ' cafe-team ' }), { name: 'Café team', slug: 'cafe-team' });
  for (const input of [null, [], {}, { name: 'Team', slug: 'team', createdBy: 'forged' },
    ...['', 'a', 'a'.repeat(81), '<img>', 'line\nbreak', 'bad\u0000name'].map(name => ({ name, slug: 'valid-slug' })),
    ...['ab', 'Upper', '-team', 'team-', 'two--words', 'two words', 'a'.repeat(49)].map(slug => ({ name: 'Team', slug }))]) {
    assert.throws(() => validateChannel(input), BadRequestException);
  }
});

test('bounds channel pages and validates canonical versioned cursors', () => {
  assert.deepEqual(validateChannelPage({}), { limit: 50 });
  assert.deepEqual(validateChannelPage({ limit: '100', cursor: Buffer.from('v1:team-one').toString('base64url') }), { limit: 100, after: 'team-one' });
  for (const input of [{ limit: '0' }, { limit: '101' }, { limit: '01' }, { limit: ['5'] }, { limit: 5 },
    { cursor: '' }, { cursor: ['bad'] }, { cursor: 'a'.repeat(101) }, { userId: 'forged' },
    ...['v2:team', 'v1:UPPER', 'v1:ab', 'v1:team\n'].map(cursor => ({ cursor: Buffer.from(cursor).toString('base64url') }))]) {
    assert.throws(() => validateChannelPage(input), BadRequestException);
  }
});
