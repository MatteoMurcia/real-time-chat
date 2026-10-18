import assert from 'node:assert/strict';
import { test } from 'node:test';
import { integrationDatabaseUrl } from './setup.js';

test('integration database configuration rejects unsafe targets without revealing credentials', () => {
  for (const environment of [
    {}, { TEST_DATABASE_URL: 'not-a-url-private-password' },
    { TEST_DATABASE_URL: 'https://private:private-password@db/example_test' },
    { TEST_DATABASE_URL: 'postgresql://private:private-password@db/development' },
  ]) {
    assert.throws(() => integrationDatabaseUrl(environment), error => error instanceof Error && !error.message.includes('private-password'));
  }
  assert.throws(() => integrationDatabaseUrl({ TEST_DATABASE_URL: 'postgresql://test:secret@db/example_test', DATABASE_URL: 'postgresql://dev:secret@db/example_test' }), /must differ/);
  assert.throws(() => integrationDatabaseUrl({ TEST_DATABASE_URL: 'postgresql://test:secret@db/example_test', DATABASE_URL: 'invalid-private-password' }), /Invalid development database URL/);
  assert.equal(integrationDatabaseUrl({ TEST_DATABASE_URL: 'postgresql://test:secret@db/example_test' }).pathname, '/example_test');
});
