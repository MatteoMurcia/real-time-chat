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
show **Sending**, **Retrying confirmation**, **Confirmed**, **Unconfirmed** or
**Rejected**. If the first attempt has no result after five seconds and the live
subscription is ready, the UI retries once automatically with the same request
key and body. After another five seconds it stays **Unconfirmed** and offers
manual retry. A timeout is not evidence that the message was lost.

Automatic retry is limited to that first deadline. Offline sends, explicit server
errors and malformed replies do not start a retry loop. Validation, conflict and
rate-limit failures are rejected; access errors end the conversation. Unexpected
failures remain unconfirmed. Manual retry requires a current unconfirmed row;
stale clicks cannot resend a pending, rejected or already confirmed message.

Socket acknowledgements are retained for at most 30 seconds per attempt, separately
from the five-second UI deadline. A valid late acknowledgement, live event or
history/recovery row converges on one canonical ID; confirming an outgoing row also matches
its author, channel, client key and body. Errors from older attempts cannot change
a newer attempt or undo confirmation. Changing/closing the view clears retry
deadlines and ignores its old responses; the transport callbacks expire within
their bounded window or on disconnection. After that window, manual retry/history/recovery
can still resolve the saved message. This is not persistent offline state.

Opening a channel subscribes first, then loads the latest 50 saved messages.
**Load earlier messages** fetches previous pages; loading, empty and recoverable
error states are explicit. Retrying a failed page keeps its cursor and already
loaded rows. Live events and page results merge by ID in sequence order. Bulk
history is not announced as live content; new events have a separate announcement.
Each page is bounded, and loaded pages stay in memory until the view closes.
Loading earlier pages preserves the first visible confirmed message and its
offset, including when the reader scrolls during the request. The list owns its
scroll anchor (native anchoring is disabled); the history button keeps its space
when exhausted, and loading/error feedback sits below the list to avoid shifting
the reading viewport. Loading a page focuses the list without scrolling the page.
While reading above the bottom, live events change the action to **New messages —
show latest**. Choosing it or scrolling back to the bottom clears the notice and
resumes following. History pages alone do not trigger this notice. It is local
to the open conversation, not a persisted unread count.

Switching/closing a conversation, navigating away or reloading clears that local
state, including drafts and retry keys; it does not delete persisted messages.
Drafts survive a temporary transport interruption while the view stays open.
Reopening loads recent saved history again. After resubscribing, an already open
conversation recovers missed messages from its last fully incorporated boundary,
including across API restarts.

### Recovery lifecycle

Opening a channel waits for its successful subscription acknowledgement before
requesting the initial snapshot H. The message listener is already attached, so
events received before that acknowledgement or while HTTP is in flight merge
with the snapshot by canonical ID and sequence; loading never replaces live rows.
The first recovery starts at H even if a newer event is already visible.

Each selection invalidates earlier subscription callbacks and cancels history
and recovery requests. Returning A-to-B-to-A starts a fresh A view: channel ID
alone cannot identify the current selection. Old success/error callbacks must
not replace its rows, cursors or authorization state. The connection serializes
room changes so a delayed unsubscribe cannot overtake the new subscribe.

The first history response seeds a separate `syncCursor` C; older-page cursors and
the history snapshot remain unchanged by recovery. The store merges each validated
sync page before advancing C, including a final empty page. Events and send acks
never advance C. New recovered rows use the existing reading anchor and new-message
notification; they do not pull a reader away from earlier messages.

Recovery runs after opening/loading the initial snapshot, after successful
resubscription, on window focus or becoming visible, and every 15 seconds while
the document is visible and the live subscription is ready. `SYNC_INTERVAL_MS`
is an Angular injection token for overriding that interval. Only one recovery is
active per open conversation; additional triggers during it are coalesced. Each
HTTP page has a five-second timeout and all pages keep the first returned H.

Hiding the document, disconnecting, changing/closing the channel or destroying
the view cancels its active HTTP work. Closing/destroying also clears the cursor,
timer and focus/visibility listeners as appropriate. Hidden or disconnected views
retain their loaded state and C and recover again when ready and visible.

Transient/malformed-response failures keep incorporated rows and the last C, show
an error and offer **Retry recovery**; focus/interval can also retry. A failed
page never advances C. A later recovery may capture a new H from the retained C.
401/403/404 clears the view. A 400 invalid-boundary response discards local message
and cursor state, invalidates pending callbacks, and reloads a fresh snapshot;
it waits for the next trigger before syncing again to avoid an immediate error
loop. The composer draft remains local to the component. No persistent offline
queue or delivery deadline is promised.

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

## Bounded recovery HTTP contract

`GET /api/channels/:id/messages/sync?after=<C>&until=<H>&limit=50` returns
`{ items, nextCursor, until, hasMore }`. `after` is required; start with the
history response's `snapshotCursor`, including the zero boundary of an empty
channel. `until` is omitted on the first recovery request so the server captures
the committed H. `limit` defaults to 50 and accepts 1–100.

Items are ascending and strictly within `(after, H]`. When `hasMore` is true,
request another page with `after=nextCursor` and the **same returned `until`**.
On the last page (including an empty interval), `nextCursor` equals `until`:
the entire interval has been checked. Advance the client's C only after merging
the complete page. Start a later recovery without `until` to capture a new H.
Live events alone must never advance C; the Angular store enforces this separation.

Both query cursors use the existing canonical version-1 snapshot representation
`[1, channelId, sequence, sequence]`, with decimal strings and zero supported.
Older-history page cursors are not sync boundaries. Cross-channel, malformed,
noncanonical, reversed (`after > until`) or future boundaries return 400, as do
unknown/repeated fields. These unsigned cursors describe positions, not authority;
the client is responsible for retaining H across requests.

Every page authenticates the session, locks the channel and rechecks membership.
The same lock used by sends makes H a committed prefix: an earlier uncommitted
writer must finish or roll back before H is read. Reads admitted before a leave
may complete; pages after it commits return 403. Invalid sessions return 401,
missing channels 404. Responses are `no-store` and expose only public fields.
The indexed query reads at most `limit + 1` rows, with no OFFSET or total count.
New traffic above H does not extend the current recovery. See
[ADR-001](decisions/001-bounded-message-recovery.md) for the guarantee and limits.

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
and reconnect/visible-tab reconciliation reads committed messages. There is no
outbox or exactly-once delivery, and ack/event may arrive in either order.

The implementation supports one API process and the synchronous in-memory
adapter. Same-channel retries serialize in PostgreSQL. If simultaneous reuse of
an author/key across different channels loses the unique-index race, the failed
transaction rolls back its row and sequence increment. A new read transaction
locks the requested channel and checks membership again before looking up the
committed key. Different channel/body returns CONFLICT; lost membership returns
FORBIDDEN. A matching request returns the canonical message with no new broadcast.
If no matching key exists, the original database error is preserved rather than
misreported as a successful retry. Recovery performs no second insert or retry
loop. Rate limiting remains 4.1a.

## Migration and verification

`chat.store.races.spec.ts` controls subscription acknowledgements and HTTP streams
to verify events on both sides of H, A-to-B-to-A snapshots and errors, obsolete
subscription results, and cancellation of a partially recovered interval. Removing
the subscription revision guard makes the stale-selection regression fail.
`e2e/channel-races.spec.ts` uses real authenticated sends and held HTTP responses:
events render before snapshot capture and delivery, merge once, and continue after
loading. It then releases old A/B snapshots after a fresh A snapshot and checks
canonical IDs, the next recovery cursor and continued room delivery. No production
fault flags, new runtime state or protocol changes were needed for task 3.3a.

`sync.service.spec.ts` checks fixed-H pagination, cancellation, timeout, invalid
pages, sequence order and non-progressing responses. Store tests use controlled
time for focus/visibility/interval triggers, single active recovery, cancellation,
retaining C after failure, invalid-cursor reset and authorization errors. Removing
the active-recovery guard makes the overlap regression test fail.

`e2e/reconnect.spec.ts` opens an empty channel, disconnects the browser, writes
105 messages through a separate authenticated socket, restarts the isolated API
and checks all three recovered pages and exact IDs without reloading the view.
It also verifies draft retention, fixed H, recoverable HTTP failure, manual retry
without duplicates and focus after closing. History fault routes match only the
history endpoint; the late-ack E2E deliberately makes HTTP recovery unavailable
to keep its original acknowledgement-specific assertions meaningful.

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

Task 3.1a adds ten concurrent socket retries and ten direct service transactions,
plus mixed-body requests for one key. A query barrier makes two channel
transactions observe the same absent key before insertion; exactly one wins and
the losing counter rolls back. A second case commits leave before the recovery
lock and expects FORBIDDEN. An unrelated sequence-index violation remains a
database error. A test-only Socket.IO middleware discards the acknowledgement
after the real commit/publication: the client times out, then retries the same
key and receives the saved message once without another event. These hooks live
only in integration tests; no production fault-injection option is added.

Task 3.1b adds reducer/store tests for ack/event/timeout permutations, stale
attempt failures, preserved request identity, one automatic retry, definitive
errors, offline state and view teardown. `e2e/message-retry.spec.ts` intercepts
WebSocket frames against the real compiled API: it releases an ack after the UI
deadline, drops both initial/automatic confirmations, retries manually, and
checks the persisted IDs through history. Invalid text is sent to the real API
to verify rejection does not trigger a retry. The transport interceptor exists
only in Playwright tests.

Reference: [Prisma 7 transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions).
