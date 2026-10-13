import { expect, it } from 'vitest';
import { reduceMessages, type MessageState } from './message.reducer';

const request = { channelId: 'channel', clientMessageId: 'key', body: 'Hello' };
const message = { ...request, id: 'saved', sequence: '9007199254740993', author: { id: 'me', displayName: 'Alice' }, createdAt: '2026-10-13T00:00:00Z' };
const confirm = { type: 'confirm' as const, message, userId: 'me' };
const pending = () => reduceMessages({ messages: [], outgoing: [] }, { type: 'queue', request });

it.each(['ack-event', 'event-ack', 'timeout-ack-event', 'timeout-event-ack'])('converges %s without resurrecting a confirmed row', order => {
  let state = pending();
  for (const step of order.split('-')) state = reduceMessages(state, step === 'timeout' ? { type: 'unconfirmed', request, attempt: 1 } : confirm);
  state = reduceMessages(state, { type: 'rejected', request, attempt: 1 });
  expect(state.messages).toEqual([message]); expect(state.outgoing).toEqual([]);
});

it('ignores failures from an older attempt, but accepts its late canonical success', () => {
  let state = reduceMessages(pending(), { type: 'unconfirmed', request, attempt: 1 });
  state = reduceMessages(state, { type: 'retry', request });
  expect(state.outgoing[0]?.request).toBe(request);
  for (const type of ['unconfirmed', 'rejected'] as const) state = reduceMessages(state, { type, request, attempt: 1 });
  expect(state.outgoing[0]).toEqual({ request, state: 'pending', attempt: 2 });
  state = reduceMessages(state, confirm);
  expect(reduceMessages(state, { type: 'unconfirmed', request, attempt: 2 }).outgoing).toEqual([]);
});

it('does not retry rejected/pending rows or clear another author, body or channel', () => {
  expect(reduceMessages(pending(), { type: 'retry', request }).outgoing[0]?.attempt).toBe(1);
  let state = reduceMessages(pending(), { type: 'rejected', request, attempt: 1 });
  state = reduceMessages(state, { type: 'retry', request });
  expect(state.outgoing[0]?.state).toBe('rejected');
  for (const other of [{ ...message, author: { id: 'other', displayName: 'Bob' } }, { ...message, body: 'Different' }, { ...message, channelId: 'other' }]) {
    expect(reduceMessages(pending(), { ...confirm, message: other }).outgoing).toHaveLength(1);
  }
});

it('keeps exact sequence order and preserves requests when disconnected', () => {
  const state: MessageState = reduceMessages(pending(), confirm);
  const lower = { ...message, id: 'lower', sequence: '9007199254740992' };
  expect(reduceMessages(state, { ...confirm, message: lower }).messages.map(item => item.id)).toEqual(['lower', 'saved']);
  expect(reduceMessages(pending(), { type: 'disconnect' }).outgoing[0]).toEqual({ request, state: 'unconfirmed', attempt: 1 });
});
