# Channels and membership

Sign in and open `/workspace`. Create a channel with a display name and a slug.
The creator becomes its first member. Every authenticated user can discover it;
the directory shows **Member** or **Open channel** for the current user.
Use **Join** or **Leave** in the directory to change your membership. The creator
can also leave; the channel remains discoverable. Socket subscription endpoints
are available; the conversation UI and messages are subsequent tasks.

## HTTP contract

All paths use the `/api` prefix and return `Cache-Control: no-store`. All
endpoints validate the existing HttpOnly session against PostgreSQL.

| Request | Response | Requirements |
| --- | --- | --- |
| `POST /channels` with `{ "name": "Design team", "slug": "design-team" }` | 201 `{ channel }` | JSON, exact origin/Referer and session-bound CSRF |
| `GET /channels?limit=50&cursor=…` | 200 `{ channels, nextCursor }` | Authenticated session |
| `PUT /channels/:id/membership` | 200 `{ channelId, isMember: true }` | Session, exact origin/Referer and session-bound CSRF |
| `DELETE /channels/:id/membership` | 200 `{ channelId, isMember: false }` | Same as PUT |

Obtain fresh mutation CSRF from `GET /auth/session/csrf`. Do not supply user IDs,
creator IDs or membership data: unknown input fields are rejected. A public
channel contains only `id`, `name`, `slug`, `createdAt` (ISO timestamp) and
`isMember`; internal normalized names and sequence counters stay server-side.

- **Name:** trim, normalize Unicode NFC and collapse repeated ASCII spaces;
  2–80 Unicode characters consisting of letters, marks, numbers, spaces,
  apostrophes, periods or hyphens. Uniqueness uses the normalized name converted
  to lowercase, stored in `nameKey` with a unique constraint.
- **Slug:** trim; 3–48 lowercase ASCII letters/numbers separated by single
  hyphens. Uppercase, repeated/leading/trailing hyphens and duplicates are rejected.
- **Pagination:** 50 by default, 1–100 allowed. Ascending unique slug order, with
  an indexed `slug > cursor` boundary and one extra row to determine continuation.
  Pass `nextCursor` unchanged; null means the end. Cursors are canonical base64url
  of `v1:<slug>`, bounded and validated. They are not credentials or snapshots.
  New channels sorting before the current boundary appear after refreshing from
  the first page. The UI keeps one page in memory and retains it on failed reads.
- **Errors:** existing safe ApiError envelope; 400 invalid fields/query, 401
  missing/expired/revoked session, 403 CSRF/origin failure, 409 name or slug conflict.
  Database unique constraints arbitrate concurrent creates.

Creation uses one Prisma nested write for the channel and initial membership.
If membership insertion fails, the channel rolls back. Membership has a composite
user/channel primary key and foreign keys; channel deletion and editing are not exposed.
`lastSequence` starts at zero for the planned message sequence, but is not part of
this API. Membership data is filtered to the current user in a bounded relation
query, rather than fetching member lists or issuing a query per channel.

Creation is not an idempotent API. The browser blocks double submission but never
automatically retries a POST. After an uncertain result, it preserves input and
asks the user to refresh the directory; a confirmed duplicate returns 409.

## Joining and leaving

Membership mutations accept a UUIDv4 channel ID, no query parameters and no body.
The session determines the user; supplying another
user ID is rejected. Both methods are idempotent: repeated PUT preserves
`joinedAt`, and repeated DELETE succeeds when the membership is already absent.
Unknown channels return 404 even on DELETE; malformed IDs return 400. Session
failures return 401, CSRF/origin failures 403, and database failures a safe 500.

Each mutation locks the channel row inside its transaction before updating the
membership. Concurrent mutations on that channel serialize; success is returned
only after commit. `ChannelAccessService.requireMember` checks persisted membership
and denies access after removal, including for the creator. Dependent writes must
check it within the same channel-locked transaction. There are no channel message
routes yet.

The browser updates membership only after a validated response. It blocks
overlapping mutations and list refreshes while a request is pending, retains
keyboard focus, and announces the result. After timeout, network failure or an
invalid response, it shows **Status unconfirmed**. **Retry** repeats the original
PUT/DELETE intent with fresh CSRF; it never toggles based on an uncertain result.
There are no automatic retries. Refresh reconciles with server state; other tabs
also need a refresh; the directory does not consume socket revocation events yet.

## Socket subscriptions

Send `channel:subscribe` or `channel:unsubscribe` with exactly `{ channelId }`
and a Socket.IO acknowledgement callback. IDs are validated UUIDv4 strings.
Success is `{ ok: true, data: { channelId, subscribed } }`; failure is
`{ ok: false, error: { code, message, requestId } }`, with safe error text.
Malformed payloads return VALIDATION_ERROR, invalid sessions UNAUTHENTICATED,
nonmembers FORBIDDEN and unknown subscription channels NOT_FOUND. Unexpected
failures return INTERNAL_ERROR without database details.

Every operation revalidates the handshake cookie against PostgreSQL. Subscribe
also checks current membership under the channel row lock; it never creates
membership. Each socket has at most one active channel. A successful subscribe
replaces its previous room; a failed subscribe preserves it. Unsubscribe is
idempotent, removes only the requested room and retains database membership.
It succeeds even for an absent channel. Reconnecting starts without a channel;
clients must explicitly subscribe again. The Angular conversation client is 2.3b.

The local per-channel queue spans the database transaction **and** room changes.
The ordering is queue → database row lock → commit → local room change → reply.
If subscribe wins, DELETE subsequently removes all of that user's sockets from
the channel. If DELETE wins, the queued subscribe sees no membership and fails.
PUT uses the same queue. Successful DELETE also emits `channel:access-revoked`
with `{ channelId }` to the user's connected sockets, including other sessions;
other users retain their subscriptions. Repeated DELETE may repeat this event.
The directory still reconciles on refresh; future conversation views will consume
the event to clear their active view. A failed DELETE retains membership and rooms.

Room changes use Socket.IO's synchronous in-memory adapter, and the socket index
is cleaned on disconnect. This guarantee supports **one API instance**. A shared
adapter alone is insufficient for multiple instances: coordination and revocation
must also be distributed before scaling. Do not add an asynchronous adapter without
revisiting the room-change boundary. Future channel broadcasts must participate
in this ordering; a room is never a substitute for permission checks.

Immediate logout disconnection, idle-session expiry and delivery-time session
filtering remain task 3.4a. Current events reject revoked/expired sessions on the
next operation; no message broadcasting exists yet. See the official
[Socket.IO room lifecycle](https://socket.io/docs/v4/rooms/).

## Verification and local operation

Use the [local Compose guide](local-development.md). The additive migration runs
through the existing migration service; stop/recreate the stack without removing
its volume when updating images. Older application images can ignore these new
tables, so rolling back application code does not require deleting channel data.

API tests cover validation, forged creator IDs, session CSRF, concurrent
uniqueness, creator/observer membership flags, pagination and a forced membership
constraint failure proving rollback. Chromium covers two independent users,
keyboard interaction, double submit, duplicates, read failure/recovery and
320/768/1024/1440 px layouts. Membership integration covers repeated/concurrent
requests, authorization, access revocation and database failures. Chromium drops
a successful DELETE response after commit and verifies that manual retry leaves
the user outside the channel without affecting another user's membership.
Real Socket.IO integration additionally checks two sockets, active-channel changes,
disconnect/reconnect, expired/revoked sessions and both subscribe/leave orders
with explicit barriers. A proxy test covers three sockets and HTTP revocation
against the compiled Compose stack.
Run the documented isolated E2E suite, never against
the working database. Rate limiting remains planned in 4.1a.

Reference: [Prisma 7 nested-write transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions).
