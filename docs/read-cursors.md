# Persisted read cursors

Read progress is a private, server-side boundary per user and channel. It is
shared by that user's sessions and survives API/container recreation. The
cursor is an explicit client report, not proof that a person read the content.
Task 6.1a provides the API/storage only; it does not add counters, automatic
marking, cross-tab notifications or a UI read receipt.

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
of who authored its messages. Whether future unread counters exclude a user's
own messages, and when a visible UI may advance the boundary, belong to 6.1b/CP6-A.
Receiving a live event alone does not mark anything read in this implementation.

## Verification

- [Integration](../apps/api/test/integration/read-cursor.ts): authenticated HTTP
  updates from independent sessions, stale requests, user/channel isolation,
  membership/CSRF/origin/content validation, exact BIGINT values and observed
  PostgreSQL lock waits against leave and delayed commit/rollback.
- [Boundary validation](../apps/api/test/read-cursor.spec.ts): canonical strings,
  numeric limits and forged/invalid fields.
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
