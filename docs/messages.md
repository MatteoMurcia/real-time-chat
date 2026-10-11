# Persistent messages

The API accepts messages over authenticated Socket.IO. The conversation UI is
task 2.3b; see [channels.md](channels.md) for membership and subscriptions.

## Wire contract

Emit `message:send` with an acknowledgement callback and exactly
`{ channelId, clientMessageId, body }`. Both IDs must be UUIDv4 strings. Text
accepts 1–2,000 Unicode code points; whitespace-only, NUL and malformed Unicode
are rejected. Whitespace, line breaks and normalization form are preserved.
This is plain text, not HTML. Unknown fields, including author identity, are
rejected. Socket payloads are limited to 16 KiB; HTTP JSON remains 8 KiB.

Success is `{ ok: true, data: message }`. `message:created` carries the same
canonical message object:

| Field | Representation |
| --- | --- |
| `id`, `channelId`, `clientMessageId` | UUID strings |
| `sequence` | Positive decimal string, safe beyond JavaScript's integer range |
| `body` | Original plain text |
| `author` | Only `{ id, displayName }` |
| `createdAt` | Server timestamp as an ISO string |

Failure is `{ ok: false, error: { code, message, requestId } }`. Invalid input
returns VALIDATION_ERROR, invalid session UNAUTHENTICATED, missing membership
FORBIDDEN and an unknown channel NOT_FOUND. A previously stored author/key with
different channel or text returns CONFLICT. Unexpected failures return
INTERNAL_ERROR; logs contain code/requestId, not message text or database details.

## Ordering and retries

The sender's session is revalidated inside the local channel queue. Within one
PostgreSQL transaction, the service locks the channel row, checks membership,
looks up `(authorId, clientMessageId)`, increments `lastSequence`, and inserts the
message. Counter and row commit together; if PostgreSQL aborts the transaction,
both changes roll back. Database constraints enforce unique author/key and channel/sequence pairs,
positive sequences, nonempty text and restrictive foreign keys.

Retries keep their key, channel and exact text. Each is authorized again and
returns the existing message without another sequence or broadcast. Another
author can independently use the same key. Leaving blocks retries too. Sending
requires membership but not subscription; only subscribed sockets receive events.

The queue spans commit and emission, sharing the ordering of join/leave/subscribe.
Success and events occur only after commit. Recipients are checked against live
session records in one query before emission. Revoked/expired sessions are excluded
and sockets must still occupy the room. This advances the delivery filter from
3.4a because messages now carry content; active disconnection and timers remain
in that task. Already transmitted events cannot be recalled.

Delivery is best-effort. A crash or delivery-check failure after commit can leave
a stored message without an event or successful ack. Timeout does not prove
rollback; retry can recover the canonical message. History and reconnect
reconciliation remain pending. There is no outbox or exactly-once delivery, and
ack/event may arrive in either order.

The implementation supports one API process and the synchronous in-memory
adapter. Same-channel retries serialize in PostgreSQL. Simultaneous reuse of a
key across different channels cannot duplicate data, but the losing unique-key
transaction can currently return INTERNAL_ERROR; recovery outside the aborted
transaction belongs to 3.1a. Rate limiting remains 4.1a.

## Migration and verification

The additive `20261011150000_create_messages` migration creates Message and its
indexes/constraints. Follow the [Compose update guide](local-development.md):
stop the API before migration and preserve its volume. Older images can ignore
the new table, so application rollback does not require deleting messages.

API tests exercise Unicode/input limits, parallel PostgreSQL transactions,
concurrent socket retries, ordering, conflicts, public fields, authorization,
expired/revoked recipients and sequences above JavaScript's safe integer range.
A deferred PostgreSQL constraint trigger fails at COMMIT after insertion: no
successful ack/event, row or counter increment survives. Retry after removing
the trigger succeeds. Proxy tests cover deduplicated delivery, denial after
leave and recovery of the exact message after recreating all containers.

Reference: [Prisma 7 transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions).
