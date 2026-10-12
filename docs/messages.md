# Persistent messages

The API accepts messages over authenticated Socket.IO. Members can open a live
conversation from the workspace directory; see [channels.md](channels.md) for
membership and subscriptions.

## Conversation UI

Join a channel and choose **Open chat** in `/workspace`. Two signed-in users in
independent browser profiles or contexts can exchange plain text, with author,
server time and confirmation state. Enter sends, Shift+Enter adds a line break,
and Enter during IME composition does not send. HTML is rendered as literal text.
The message list follows new content while at the bottom; scrolling up keeps the
reading position and **Show latest messages** returns to the bottom.

One authenticated socket serves the workspace. Room changes are serialized, sends
are disabled until subscription is confirmed, and reconnection resubscribes the
active channel. Closing the conversation removes its event listeners and
unsubscribes without leaving the membership. Leaving revokes the view's access,
clears its content and blocks further sends; stale acknowledgements cannot reopen it.

`message:created` and successful send acknowledgements converge on the same
message ID. Confirmed rows use exact BIGINT sequence ordering. Outgoing messages
show **Sending**, **Confirmed**, **Unconfirmed** or **Rejected**. A five-second
timeout or unexpected server error means unconfirmed, not lost. Manual retry
keeps the original client key and body. Definitive validation/conflict failures
do not retry automatically; the user can copy and correct the text in the composer.

Opening a channel subscribes first, then loads the latest 50 saved messages.
**Load earlier messages** fetches previous pages; loading, empty and recoverable
error states are explicit. Retrying a failed page keeps its cursor and already
loaded rows. Live events and page results merge by ID in sequence order. Bulk
history is not announced as live content; new events have a separate announcement.
Each page is bounded, and loaded pages stay in memory until the view closes.
Precise scroll anchoring while prepending is the next task, 2.4b.

Switching/closing a conversation, navigating away or reloading clears that local
state, including drafts and retry keys; it does not delete persisted messages.
Drafts survive a temporary transport interruption while the view stays open.
Reopening loads recent saved history again. Full retry reconciliation (3.1b) and
reconnect gap recovery (3.2b) remain pending; resubscribing an already open view
does not automatically fetch messages missed during the interruption.

## History HTTP contract

`GET /api/channels/:id/messages?before=<olderCursor>&limit=50` requires a valid
session and current channel membership. `before` is optional; `limit` defaults
to 50 and accepts decimal integers 1–100. Unknown/repeated query fields, invalid
UUIDs and malformed, noncanonical, future or cross-channel cursors return 400.
Invalid sessions return 401, nonmembers 403 and nonexistent channels 404.
Responses use `Cache-Control: no-store` and only the public message projection.

The response is `{ items, olderCursor, snapshotCursor }`. Items are ascending by
sequence, irrespective of equal timestamps. A null older cursor means no earlier
page. The first transaction locks the channel, authorizes membership and captures
the committed `lastSequence` as H. It selects at most `limit + 1` rows descending
using the existing `(channelId, sequence)` index and returns the selected page
ascending. The same channel lock orders the read against sends and membership
changes; a read admitted before leave can complete, subsequent reads are denied.

Version 1 cursors are canonical base64url JSON `[1, channelId, sequence, H]`;
sequences are decimal strings, never JavaScript numbers. An older cursor uses the
earliest returned sequence as an exclusive upper boundary and retains H. Each
page revalidates membership and reads only `sequence < before` and `sequence <= H`.
New writes therefore cannot move the older pages. The snapshot cursor encodes H
in both sequence slots; an empty channel encodes zero and has no older cursor.
An empty snapshot cannot be used as `before`. Clients treat cursors as opaque;
they are neither signed capabilities nor substitutes for authorization.

The Angular store keeps `snapshotCursor` separate from `olderCursor`; events do
not advance either. Switching channels or access revocation cancels HTTP work
and clears both. This is a committed message boundary, not a snapshot of mutable
author display names or a future edit/delete policy. No schema migration is needed.

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
rollback; retry can recover the canonical message. Saved history can be loaded,
but reconnect reconciliation remains pending. There is no outbox or exactly-once delivery, and
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
