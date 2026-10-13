# ADR-001: Recover a committed message interval with a fixed upper boundary

## Status

Accepted through PR #35; implemented by task 3.2a.

## Date

2026-10-13

## Context

Events can be lost after a message commits. A client must recover persisted
messages without skipping a delayed commit or chasing an ever-growing stream.
History pagination already exposes a committed snapshot boundary. PostgreSQL
serializes each channel's message counter, inserts and membership changes under
the same channel-row lock.

## Decision

Use an authorized HTTP endpoint to page ascending through `(C,H]`. Each page
holds the existing channel lock while authorizing membership and querying the
bounded interval. The first page captures H from `lastSequence` after acquiring
that lock; later pages reuse H. Counter and message commit atomically, so no
earlier sequence can subsequently commit behind this boundary through the
supported write path. A rollback contributes neither a row nor a sequence.

Reuse version-1 history snapshot cursors as sync boundaries, including zero.
Keep decimal BIGINT strings on the wire and validate channel, canonical encoding,
range and ordering. Cursors are unsigned positions; session and membership
checks on every page provide authorization. Return the last included sequence
while more rows remain, and H once the interval is exhausted. Clients retain H,
merge each complete page, then advance C; events never advance C by themselves.

## Alternatives considered

- Timestamps or an independently allocated/global sequence do not establish
  per-channel commit order. A delayed transaction could commit behind C.
- Moving H on every page may never finish under sustained traffic.
- Holding one transaction across multiple HTTP requests would retain locks and
  database resources for client-controlled durations.
- A separate recovery log, outbox or Socket.IO recovery strategy adds machinery
  unnecessary for this bounded persisted-message read. None is introduced here.

## Consequences

The existing `(channelId, sequence)` index supports `limit + 1` reads without
OFFSET. Page reads briefly serialize with same-channel writes and membership
changes; database transaction/lock failures use the existing safe error envelope
and can be retried without writes. This is a finite logical interval, not a
wall-clock completion guarantee under contention or failures.

The guarantee assumes immutable persisted messages and the supported transactional
counter path. Demo data resets invalidate client state; cursors do not certify a
snapshot of mutable author profiles. Deletion/edit policy and data-generation
tokens would require an explicit future contract. No schema or dependency changes.

The application still targets one API instance. This endpoint does not itself
schedule browser recovery or guarantee exactly-once delivery. Task 3.2b adds
visible-channel orchestration; further initial-load races and commit-without-event
demonstrations remain in 3.3a–3.3b.

## Evidence

`message-sync.ts` integration covers three pages, writes between pages, empty and
completed intervals, authorization per page, invalid boundaries and interoperability
with history snapshots. `message-sync-races.ts` observes actual PostgreSQL lock
waits while a writer is held before commit or rollback, then checks the captured
boundary and subsequent recovery. Unit tests cover canonical parsing and BIGINT
limits; integration also exercises sequences above JavaScript's safe integer range.
