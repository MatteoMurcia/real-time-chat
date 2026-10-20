import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resetDemo, validateResetConnection } from './reset-demo.mjs';

test('reset only accepts the fixed internal demo connection, without query overrides', () => {
  const valid = 'postgresql://demo_local:synthetic@db:5432/chat_demo';
  assert.equal(validateResetConnection(valid), valid);
  for (const value of [undefined, 'not a URL', valid.replace('chat_demo', 'real_time_chat'), valid.replace('@db:', '@remote:'),
    valid.replace('demo_local:', 'chat_local:'), `${valid}?host=remote`, `${valid}#other`, valid.replace(':5432/', ':5433/')]) {
    assert.throws(() => validateResetConnection(value));
  }
});

for (const target of [undefined, { database: 'real_time_chat', role: 'demo_local', marker: 'real-time-chat:local-demo:v1' },
  { database: 'chat_demo', role: 'demo_local', marker: null }, { database: 'chat_demo', role: 'other', marker: 'real-time-chat:local-demo:v1' }]) {
  test(`reset refuses an unmarked or different actual target: ${JSON.stringify(target)}`, async () => {
    let writes = 0;
    const tx = { $executeRaw: async () => {}, $queryRaw: async () => target ? [target] : [], $executeRawUnsafe: async () => { writes++; } };
    await assert.rejects(resetDemo({ $transaction: async callback => callback(tx) }, 'chat_demo'));
    assert.equal(writes, 0);
  });
}

test('explicit confirmation is required before any database work', async () => {
  let connected = false;
  for (const confirmation of [undefined, '', 'yes', 'real_time_chat']) {
    await assert.rejects(resetDemo({ $transaction: async () => { connected = true; } }, confirmation));
  }
  assert.equal(connected, false);
});

test('confirmed demo reset explicitly includes read cursors without cascading', async () => {
  const statements = [];
  const tx = { $executeRaw: async () => {}, $queryRaw: async () => [{ database: 'chat_demo', role: 'demo_local', marker: 'real-time-chat:local-demo:v1' }],
    $executeRawUnsafe: async sql => { statements.push(sql); } };
  await resetDemo({ $transaction: async callback => callback(tx) }, 'chat_demo');
  const truncate = statements.find(sql => sql.startsWith('TRUNCATE TABLE'));
  assert.match(truncate, /public\."ReadCursor"/);
  assert.doesNotMatch(truncate, /CASCADE/);
});

test('reset CLI refuses unconfirmed input without printing private arguments', () => {
  const secret = 'private-reset-canary';
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./reset-demo.mjs', import.meta.url)), '--confirm', secret], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /Demo reset refused or failed/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
});
