import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectionsService } from '../src/realtime/connections.service.js';
import { EMPTY } from 'rxjs';
import type { SessionService } from '../src/identity/session.service.js';

test('channel coordination spans completion, allows other channels and releases after errors', async () => {
  const connections = new ConnectionsService({ revoked: EMPTY } as unknown as SessionService);
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = connections.withChannel('one', async () => { order.push('first'); await held; throw new Error('rollback'); });
  const rejected = assert.rejects(first, /rollback/);
  const second = connections.withChannel('one', async () => { order.push('second'); });
  await connections.withChannel('two', async () => { order.push('independent'); });
  assert.deepEqual(order, ['first', 'independent']);
  release();
  await Promise.all([rejected, second]);
  assert.deepEqual(order, ['first', 'independent', 'second']);
  await connections.withChannel('one', async () => { order.push('next'); });
  assert.equal(order.at(-1), 'next');
});
