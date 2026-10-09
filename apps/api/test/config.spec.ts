import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

const databaseUrl = 'postgresql://test:example@127.0.0.1:5432/chat_test';

test('loads a valid configuration with a loopback host by default', () => {
  assert.deepEqual(loadConfig({ NODE_ENV: 'development', PORT: '3000', DATABASE_URL: databaseUrl }), {
    nodeEnv: 'development',
    port: 3000,
    host: '127.0.0.1',
    databaseUrl,
    appOrigin: 'http://127.0.0.1:8080',
  });
});

test('accepts explicit origins and rejects unsafe or ambiguous origin configuration', () => {
  const env = { NODE_ENV: 'test', PORT: '3000', DATABASE_URL: databaseUrl };
  for (const APP_ORIGIN of ['https://chat.example', 'http://localhost:4200']) {
    assert.equal(loadConfig({ ...env, APP_ORIGIN }).appOrigin, APP_ORIGIN);
  }
  for (const APP_ORIGIN of ['*', 'null', 'http://chat.example', 'https://chat.example/',
    'https://user:password@chat.example', 'https://chat.example/path', 'https://chat.example?query']) {
    assert.throws(() => loadConfig({ ...env, APP_ORIGIN }), /APP_ORIGIN must/);
  }
});

test('accepts an explicit bind address for containers', () => {
  assert.equal(
    loadConfig({ NODE_ENV: 'production', PORT: '8080', HOST: '0.0.0.0', DATABASE_URL: databaseUrl }).host,
    '0.0.0.0',
  );
});

test('rejects absent or malformed database URLs without exposing credentials', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', PORT: '3000' }), /DATABASE_URL is required/);
  for (const value of ['private-password', 'https://user:private-password@host/db', 'postgresql://host']) {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', PORT: '3000', DATABASE_URL: value }), {
      message: 'DATABASE_URL must be a PostgreSQL connection URL with a database name',
    });
  }
});

test('rejects missing or invalid required configuration without exposing values', () => {
  assert.throws(() => loadConfig({ PORT: '3000' }), /NODE_ENV is required/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test' }), /PORT is required/);
  assert.throws(
    () => loadConfig({ NODE_ENV: 'private-value', PORT: '3000' }),
    { message: 'NODE_ENV must be development, test, or production' },
  );
});

for (const port of ['', ' ', '0', '-1', '65536', '3.5', '3000oops', '1e3']) {
  test(`rejects invalid port ${JSON.stringify(port)}`, () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', PORT: port }), /PORT/);
  });
}

test('rejects an empty or invalid bind address', () => {
  for (const host of ['', ' ', 'not-an-ip']) {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', PORT: '3000', HOST: host }),
      /HOST must be an IP address/,
    );
  }
});
