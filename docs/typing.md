# Ephemeral typing

An open conversation shows other users typing above the message field. The
status uses a polite, atomic live region and reserves one line of space. It
never changes focus, sends a draft, saves a message or advances a read cursor.

## Socket contract

`typing:update` accepts exactly `{ channelId: UUID, typing: boolean }`. An optional
acknowledgement returns `{ ok: true, data: { channelId } }` or the existing safe
`{ ok: false, error }` envelope. Invalid types, extra fields and client-supplied
identity/text are rejected. The UI uses a volatile event without waiting for an
ack; this optional status never blocks sending a message or retries an event.

The API consumes the shared per-user typing quota before validation, queueing
or database work: **10 attempts per 10 seconds**, including stop/invalid attempts,
across sockets/sessions. `TYPING_LIMIT` changes the threshold, not its duration;
it is separate from the message budget. See [traffic limits](traffic-limits.md).

Every accepted update reauthenticates the cookie, checks the socket's session,
locks the channel and requires membership. The socket must also subscribe to
that channel. Publication shares the process-local channel queue with membership
changes; it rechecks connection state after awaiting the recipient session read.
Active signals reach only currently subscribed sockets with valid DB sessions.

`typing:changed` carries `{ channelId, connectionId, user }`, where `user` is the
server-derived `{ id, displayName }`, or `null` to clear that connection. The
connection ID is the public ephemeral Socket.IO ID, never a session ID or token.
No email, draft text or read progress is included. The sender is excluded, and
the browser ignores its own user's other tabs. Stop signals carry no user data.

## Expiry and lifecycle

- During continuous typing, start/renew signals are spaced by at least **2
  seconds** while the visible view has an acknowledged live subscription. A new
  typing period after stop can start immediately; the server quota still applies.
  Input renews local inactivity cleanup.
- A received signal expires **5 seconds after receipt**, renewed separately per
  connection. Two tabs belonging to one user show one name; stopping one tab
  leaves the other tab's valid signal visible. Up to 100 connection entries are
  retained in a view; the status names three users and counts any additional ones.
- Empty input, blur, successful send, hidden document, channel change or view
  destruction sends a best-effort stop. Channel unsubscribe, membership leave,
  socket disconnect and session closure also clear the server's connection marker
  and emit a stop to the remaining room. Client timers and listeners are cleaned up.
- A disconnected view clears received state. Reconnection does not replay typing
  or broadcast a retained draft; fresh input is required after subscription.

Visibility comes from the workspace's existing `ActivityService.visible` signal;
the conversation does not register another document visibility listener. The
unchanged responsive E2E checks listener counts across twenty channel changes,
closing the view and leaving/returning to the workspace.

Both directions use [Socket.IO volatile events](https://socket.io/docs/v4/emitting-events/#volatile-events):
signals may be dropped while the transport is busy. In particular,
[offline events must not be buffered](https://socket.io/docs/v4/client-offline-behavior/).
TTL cleanup works without a stop or detection of the writer's broken connection.
Browser suspension and network delay mean this is not a wall-clock delivery SLA.
New subscribers receive future activity, not a snapshot or replay.

## Verification and limits

[API tests](../apps/api/test/typing.spec.ts) cover exact validation and the sliding
quota. [Real PostgreSQL/socket integration](../apps/api/test/integration/typing.ts)
covers unauthorized/forged updates, subscription scope, unsubscribe, abrupt
transport closure, membership leave, shared session quotas and no message/read
writes. [Controlled-clock store tests](../apps/web/src/app/features/chat/typing.store.spec.ts)
cover 5-second expiry/renewal, 2-second throttling, tab deduplication, malformed
events and lifecycle cleanup. The transport test prevents offline buffering.
[Chromium E2E](../e2e/typing.spec.ts) exercises two users, an offline writer,
reconnection, close/send cleanup and payloads without draft text, retaining
desktop/mobile screenshots. A 72-character unbroken name fits at 375 px without
horizontal overflow. These checks do not prove screen-reader behavior.

There is no database model, migration, durable activity queue, HTTP typing
endpoint or recovery history. Connection markers/rooms are process-local;
multiple API instances and capacity benchmarks remain separate work. The
[presence protocol](presence.md) is implemented separately; its visual UI follows
in 6.3b.
