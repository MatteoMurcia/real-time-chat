# ADR-004: Commit ordered, idempotent messages before acknowledging or emitting

## Status

Accepted. Records the implemented write/retry contract; complements ADR-001.

## Date

2026-10-19

## Context

A timeout cannot tell the sender whether a write committed. Clients can retry
concurrently, and commit can precede a crash or lost event. The application needs
one canonical persisted message per supported retry key, without promising
exactly-once network delivery.

## Decision

The server derives the author from the authenticated session. In a transaction,
lock the channel row, check membership, look up `(authorId, clientMessageId)`,
increment the per-channel counter and insert the message. Counter and row commit
together. Unique author/key and channel/sequence constraints back the write path.
Sequence is a decimal BIGINT string on the wire; timestamps are not the ordering
key and there is no global order across channels.

A retry retains key, channel and exact body and is authorized again. A match
returns the original message without another insert, sequence or event; different
channel/body conflicts. Concurrent cross-channel key reuse resolves through the
unique constraint, rollback and a fresh authorized read transaction. There is no
unbounded retry loop. Same-channel in-process coordination spans commit/emission
and membership/subscription changes.

Only after commit may the gateway emit `message:created` and return a success
ack. The browser merges ack/event/history by canonical ID and sequence. Its
five-second confirmation deadline permits one automatic retry; later manual
retry keeps the same key. Late acknowledgements are reconciled while the view
and bounded attempt listener remain alive; they are not a durable background job.

Use the fixed `(C,H]` persisted interval from
[ADR-001](001-bounded-message-recovery.md) for visible-channel recovery. Capture H
under the channel lock and reuse it through ascending pages. Live events do not
advance the recovery cursor. Reconnect, focus and the visible-tab interval trigger
reconciliation; older history pages retain their snapshot boundary.

## Alternatives considered

- Timestamp order can miss a delayed commit. A transactional per-channel counter
  gives a committed boundary; it briefly serializes same-channel work.
- A new retry key treats an uncertain send as new content and can duplicate it.
- A transactional outbox could durably schedule emission but requires a publisher
  and delivery/deduplication policy. Persisted bounded reads meet current scope;
  an outbox is deferred, not implicitly provided by Socket.IO.

## Consequences

Persistence idempotency is not exactly-once delivery. A post-commit failure can
leave a stored message without an ack/event; successful commit does not prove a
recipient saw it. Ack/event order is unspecified. Recovery depends on a valid
session/membership, reachable server and immutable messages written through the
supported path. Reset invalidates demo sessions/state. UI drafts and pending
sends are in memory and can disappear on reload; offline-first and a durable
offline queue are absent. One API instance is supported, without a load claim.

## Evidence

- [Write service](../../apps/api/src/messaging/send-message.service.ts), [schema/constraints](../../apps/api/prisma/schema.prisma), [gateway](../../apps/api/src/realtime/chat.gateway.ts).
- [Concurrent retries/conflicts](../../apps/api/test/integration/message-idempotency.ts), [commit/rollback ordering](../../apps/api/test/integration/message-sync-races.ts).
- [Commit without emission](../../apps/api/test/integration/commit-emission.ts), [fixed recovery pages](../../apps/api/test/integration/message-sync.ts).
- [Late ack/timeout browser test](../../e2e/message-retry.spec.ts), [gap recovery](../../e2e/sync-gap.spec.ts), [initial load races](../../e2e/channel-races.spec.ts).
