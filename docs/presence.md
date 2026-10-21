# User presence protocol

Presence means **at least one revalidated, connected socket with a live database
session** for a user in this API process. It does not mean attention, visible tab,
recent input or message delivery. Tabs and independent sessions are counted
internally; the public response exposes only a boolean, not connection counts,
session identifiers, names, email or last-seen timestamps. No presence is stored
in PostgreSQL. The conversation shows accessible text beside saved-message authors.

## Authorized snapshots

`presence:get` accepts exactly:

```json
{ "channelId": "channel UUID", "userIds": ["known user UUID"] }
```

Both fields use UUID v4 values. The list must contain **1–100 unique IDs**;
case is normalized before checking uniqueness. Extra fields, including a
client-selected viewer or claimed online state, are rejected. The event shares
the existing 16 KiB transport bound. The per-user sliding quota is **20 attempts
per 10 seconds** across sockets/sessions (`PRESENCE_LIMIT`); invalid attempts also
count, before validation, channel queueing or a database authentication read.
The budget is separate from messages and typing. See [traffic limits](traffic-limits.md).

The cookie selects the viewer. Every query reauthenticates the session, uses the
channel operation queue, locks the channel, checks current membership and
requires an active subscription to that channel. A room alone is not permission.
Only requested users who currently belong to that same channel are returned:

```json
{
  "ok": true,
  "data": {
    "channelId": "channel UUID",
    "users": [{ "userId": "shared member UUID", "online": true }]
  }
}
```

Results preserve requested order. Nonmembers and nonexistent users are both
omitted; absence is **not** an offline assertion. There is no global online-user
directory. The service checks candidate sessions in PostgreSQL, then counts
still-connected, revalidated sockets whose sessions remain valid. A database
session deleted behind the API cannot produce an online result from a stale
local entry. A dependency failure returns the existing safe error envelope,
never a successful all-offline response.

## Changes and lifecycle

Connection registration becomes visible only after its second session check;
disconnect during that check cannot resurrect presence. Closing one tab removes
only that socket. Normal logout closes all sockets of the affected session while
preserving another session of the same user. Existing absolute session-expiry
timers close idle expired sockets; counting also checks the deadline directly.

After confirmed registration or disconnect, the API emits `presence:changed`
to connected, locally valid sessions of users sharing at least one current
channel with the changed user. This event has **no arguments**, including no
actor, channel, status or identifiers. It only requests another authorized read;
it does not itself declare anyone offline. Multiple tabs can therefore cause a
refresh while the user's boolean remains online. These notifications do not
perform message/read writes or trigger the read-count invalidation event.

Membership and database sessions are checked again on every snapshot. Empty
invalidations may reach a socket whose session was deleted directly in SQL until
that socket closes, but it cannot read a snapshot after revocation. There is no
durable invalidation queue, membership roster or ordered snapshot/event stream.
A consumer must refresh on subscription/reconnect/focus, coalesce invalidations
while a query is pending, and periodically repair a missed hint or membership
change. Disconnected, initially loading, omitted or failed results must remain unknown;
they must not be rendered as offline. The browser implements these rules below.

## Conversation indicators

The conversation displays **Online**, **Offline** or **Presence unknown** next to
saved-message authors, with a single accessible status for loading or failure.
It queries at most the **100 most recent unique valid author IDs** in the loaded
history, not a membership roster. Other authors and omitted members remain
unknown. Labels do not announce individually or move focus or message scrolling;
reserved label/status space reduces layout movement.

A routine refresh retains the last confirmed labels until a valid new snapshot
arrives. An invalidation received while a query is pending discards that reply
and schedules one follow-up. Disconnect, a hidden document, channel change,
malformed/failed reply or omitted user clears the relevant confirmed state to
unknown. Reconnecting waits for the channel subscription to be acknowledged;
late replies from another connection or conversation cannot restore old state.
The five-second optional presence timeout does not close the chat connection.

Queries are serialized and start at least two seconds apart, coalescing hints,
focus and author-list changes. Failures clear labels and retry after ten seconds.
The existing activity service supplies visibility, focus and fifteen-second
periodic repair; there is no additional browser listener or polling interval.
The server's shared quota still applies across sessions: many open views may
receive rate-limit errors and show unknown until a later successful retry.
Presence remains a best-effort observation; this UI adds no delivery or latency SLA.

## Silent network loss

The gateway explicitly retains Socket.IO's heartbeat defaults: **25 seconds**
between pings and **20 seconds** waiting for a pong. A silent outgoing link can
therefore remain counted for up to about **45 seconds** before the server emits
`disconnect` with reason `ping timeout`. Normal close, transport errors, logout
or expiry can clean up sooner. Event-loop suspension or overload can delay timers;
this is a configured detection window, not a wall-clock delivery SLA.
See [Socket.IO heartbeat semantics](https://socket.io/docs/v4/server-options/#pingInterval).

## Evidence and limits

[Connection tests](../apps/api/test/socket-session.spec.ts) use a controlled clock
for counts, pending registration, logout and absolute expiry.
[Presence input/quota tests](../apps/api/test/presence.spec.ts) exercise invalid
and forged requests, uniqueness, batch bounds and sliding-window expiry.
[Real PostgreSQL/socket integration](../apps/api/test/integration/presence.ts)
covers multiple tabs/sessions, HTTP logout, expiry, current membership, externally
stale rooms/sessions, anonymous invalidation scoping, errors and no message/read
writes. The silent-link case leaves the real WebSocket open and suppresses
outgoing Engine.IO frames; it observes real 25s/20s heartbeat detection without a
fake clock or an injected disconnect. Its five-second scheduling allowance is a
test bound, not an additional production guarantee.

[Browser-store tests](../apps/web/src/app/features/chat/presence.store.spec.ts)
cover unknown/offline separation, malformed responses, bounded batches,
invalidation coalescing, cleanup and stale-channel rejection. The
[view test](../apps/web/src/app/features/chat/presence-view.spec.ts) checks text
association and subscription changes; [Chromium scenarios](../e2e/presence.spec.ts)
exercise two writer tabs, reader reconnect/draft preservation, offline versus
omitted members, delayed refresh, channel changes and desktop/mobile layouts.

The [plan](../tasks/plan.md) records executed commands; [PR #64](https://github.com/MatteoMurcia/real-time-chat/pull/64) records final CI status on its exact head.
One API process is supported. Shared presence/accounting and cross-instance
revocation are required before adding replicas. No remote deployment, load
benchmark, idle/away state or last-seen history is part of this task.
