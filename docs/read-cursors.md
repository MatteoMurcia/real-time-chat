# Persisted read cursors

Read progress is a private, server-side boundary per user and channel. It is
shared by that user's sessions and survives API/container recreation. The
cursor is an explicit client report, not proof that a person read the content.
Task 6.1a provides storage and the cursor API; 6.1b adds private unread counts,
visible-message marking and synchronization between the user's tabs/sessions.
It does not expose read receipts to other people.

## HTTP contract

Both endpoints use the authenticated session's user. They require current
channel membership and return `Cache-Control: no-store`:

| Request | Response |
| --- | --- |
| `GET /api/channels/:id/read-cursor` | 200 `{ "channelId": "<uuid>", "lastReadSequence": "0" }`, or the stored boundary |
| `PUT /api/channels/:id/read-cursor` with `{ "lastReadSequence": "42" }` | 200 with the stored maximum of the existing and requested boundaries |

PUT requires JSON, a matching Origin (or same-origin Referer when Origin is absent)
and a session-bound CSRF token
from `/api/auth/session/csrf`, sent as `X-CSRF-Token`, just like channel mutations.
No query parameters or additional body fields are accepted; caller-supplied
`userId`/`channelId` cannot select another user's cursor. The route's UUID selects
the channel. Types are exported by `@real-time-chat/contracts/activity`.

`lastReadSequence` is a canonical decimal **string**, from `"0"` through
`"9223372036854775807"`. It is never a JavaScript number. Zero means no message
has been marked read; it is valid even for an empty channel. Every positive
boundary must identify a committed message in this channel, including when the
request is older than the stored cursor. A future sequence, gap or sequence
existing only in another channel is invalid. A valid older request succeeds
without decreasing the stored value; it cannot clear an existing cursor.

GET returns zero without inserting a row when no cursor exists. On PUT, zero
can create the initial zero row; repeated/older writes return current progress.
Progress remains stored after leaving a channel, but GET/PUT are forbidden while
the user is not a member. Rejoining restores access to the prior progress.
Normal demo seed reruns preserve it; the explicit guarded demo reset deletes it
alongside other demo data.

The existing error envelope is retained: 400 for invalid UUID/body/query/content
or an invalid boundary, 401 for missing/invalid session, 403 for missing membership
or failed Origin/CSRF, and 404 for a valid UUID whose channel does not exist.
Authorization precedes message-existence lookup, so a nonmember cannot probe a
channel's message boundaries through the API.

## Concurrency and persistence

`ReadCursor` has the composite primary key `(userId, channelId)`, a BIGINT
`lastReadSequence` defaulting to zero and restrictive user/channel foreign keys.
A database check rejects negative values. The additive migration creates this
table/index without backfilling or changing existing conversations.

GET and PUT use the existing PostgreSQL channel-row lock inside one transaction,
then check membership. PUT validates the committed message and reads/advances
the cursor under that same lock. Concurrent sessions therefore cannot overwrite
a later boundary with an older one. The lock also defines ordering against
channel leave and message commit/rollback, using the existing authorization
boundary rather than another in-memory queue. A read accepted before leave can
complete; after leave commits, subsequent operations are rejected.

This serializes operations on a channel and shares its existing contention
limits; no throughput claim is made. The cursor is a sequence prefix, independent
of who authored its messages. The unread rule is defined below.
Receiving a live event alone never marks it read.

## Unread counts and visible reading

Confirmed product rule (2026-10-20): **only messages from other people count**.
`GET /api/channels` adds `unreadCount` to each directory entry: an integer
for a current member, or `null` for a nonmember. It counts committed messages
whose `sequence > lastReadSequence` and `authorId != authenticatedUserId`.
It is not the channel sequence minus the cursor. Missing progress means zero,
so joining includes older foreign messages; leaving hides the count, and
rejoining uses the preserved boundary. An empty channel has zero unread messages.
No user ID or count is accepted from the client. Directory pagination remains
bounded at 100 entries, with one aggregate query for counts on the returned page,
rather than a request or database query per channel.

The channel list shows a labeled count or “All caught up” without stealing focus
or announcing every counter change. Failed count refreshes hide the cached counts
and offer the existing Refresh channels action. Membership changes cancel older
background directory reads, so a late response cannot undo a confirmed leave.
An authenticated directory 401 uses the shared session-ending flow, preserving
an in-flight explicit logout and its cookie cleanup. A late 401 after sign-out
cannot replace the intended sign-out result with a session-expired redirect.
The session store also ignores a late socket end after a confirmed sign-out;
a subsequently authenticated session can still end normally.

The conversation observes each confirmed message's final “Confirmed” line using
IntersectionObserver, including clipping by the message log and browser viewport.
It reports the highest fully visible marker only when the document is visible,
the subscription is ready and history/recovery are not loading. It cannot advance
past `recoveredSequence`, which comes from validated HTTP history/sync items;
opaque recovery cursors stay opaque. Live events and send acknowledgements do
not advance that boundary. Obsolete observers cannot mark another channel after
a switch. A hidden document receiving a message or a reader scrolled above the
new message keeps it unread. A hidden tab's return triggers recovery and a fresh
visibility observation.

This is **read through this message**, not an individual-message receipt: opening
the latest page and reaching its end marks the earlier prefix read, including
older pages not loaded into this view. The browser checks document visibility,
not human attention or whether another application covers the window. These
limits follow the existing single monotonic cursor model.

PUT writes are coalesced per channel and the server's returned maximum is
authoritative. A failed or malformed confirmation leaves progress retryable,
shows a status message and does not optimistically clear a counter. Focus,
foreground activity and the 15-second refresh retry markers still in view.

## Synchronization between tabs

After a committed cursor write or membership change, the API sends an empty
`activity:changed` Socket.IO invalidation to that user's connected sessions.
A newly committed message invalidates its channel members, including sockets
without an active subscription. This signal contains no channel IDs, messages,
counts or other users' progress; the authenticated, no-store HTTP directory
query remains authoritative. Expired sockets are excluded, and the existing
session-revocation registry removes revoked connections.

The workspace refreshes its current directory page on invalidation, connection,
focus and visibility restoration; a visible-tab 15-second timer repairs a lost
signal or a commit/emission gap. Received invalidations never write a cursor.
The conversation also recovers on activity, then rechecks reached markers.
Hidden tabs defer invalidation/timer refreshes until visible. Counts on other directory pages load
when those pages are selected; Refresh channels discovers newly created entries.
The signal uses the existing process-local connection registry: multiple API
instances remain unsupported. Neither transient socket delivery nor a timer is
a durable notification guarantee.

## Verification

- [Integration](../apps/api/test/integration/read-cursor.ts): authenticated HTTP
  updates from independent sessions, stale requests, user/channel isolation,
  membership/CSRF/origin/content validation, exact BIGINT values and observed
  PostgreSQL lock waits against leave and delayed commit/rollback.
- [Boundary validation](../apps/api/test/read-cursor.spec.ts): canonical strings,
  numeric limits and forged/invalid fields.
- [Unread browser scenario](../e2e/unread.spec.ts): two tabs, own-message
  exclusion, another channel, reload, hidden reception, save failure/retry and
  scrolling above new arrivals. Headless Chromium keeps pages visible, so this
  scenario explicitly controls the browser's document-visibility boundary.
- [Activity client](../apps/web/src/app/core/activity.service.spec.ts),
  [conversation](../apps/web/src/app/features/chat/chat.spec.ts) and
  [directory](../apps/web/src/app/features/channels/channel-list.spec.ts): queued
  advances, server maximum, malformed confirmations, recovered boundaries,
  obsolete observations, membership races and count failures.
- [Seed regression](../apps/api/test/integration/demo-seed.ts): reruns preserve
  both unrelated and demo read progress.
- [Container persistence](../e2e/persistence.spec.ts) and
  [demo maintenance](../e2e/demo-maintenance.spec.ts): the same progress survives
  down/up; a guarded demo reset clears it. [Reset guards](../scripts/reset-demo.test.mjs)
  require the new table explicitly without adding `CASCADE`.

Run the [isolated database suite](local-development.md#reproducible-integration-in-containers)
and [browser checks](../README.md#browser-verification) with their documented
disposable projects. Do not migrate or reset the ordinary development database
as part of test execution. New UI/count behavior remains separate work.

[PR #60](https://github.com/MatteoMurcia/real-time-chat/pull/60) records the final branch CI and review results.
