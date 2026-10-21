# CP6-B — Authorized and clean ephemeral activity

Reviewed on **2026-10-21** against integrated `main`
`3b268bd084fa53f8581dc9439cd08245c9a45bd4`, after typing/PR #63,
presence protocol/PR #64 and presence indicators/PR #65.

This checkpoint covers ephemeral typing, authorized presence snapshots and
their interaction with conversation, reconnection and view cleanup. Capacity
measurement (6.4a) is a separate task. Owner review and merge remain manual.

**Verdict: verified for the documented single-instance local scope.**

## Acceptance evidence

| Criterion | Reviewed assertion | Executable evidence |
| --- | --- | --- |
| Trusted identity and permissions | Authenticate the cookie again; require current membership and the active subscription. Reject client-supplied identity, draft text, extra fields and invalid IDs. | [Gateway](../../apps/api/src/realtime/chat.gateway.ts), [typing validation](../../apps/api/test/typing.spec.ts), [presence validation](../../apps/api/test/presence.spec.ts), [typing integration](../../apps/api/test/integration/typing.ts), [presence integration](../../apps/api/test/integration/presence.ts) |
| Quotas and data projection | Typing has a separate shared-user 10/10s budget; presence has 20/10s and at most 100 requested IDs. Typing publishes only server-derived public identity; presence returns booleans only for shared members and emits empty invalidations. | [Typing contract](../typing.md), [presence contract](../presence.md), [input/quota tests](../../apps/api/test/presence.spec.ts), [presence integration](../../apps/api/test/integration/presence.ts) |
| Typing expiry and multiple tabs | Five-second receiver TTL is renewed per connection. One user's tabs produce one name; stopping one tab does not clear another. Reconnect needs new input and does not replay a draft. | [Typing store tests](../../apps/web/src/app/features/chat/typing.store.spec.ts), [typing browser scenario](../../e2e/typing.spec.ts) |
| Membership and connection cleanup | Application-managed leave shares the publication queue, removes rooms and clears typing. Unsubscribe clears that channel's room/typing state; disconnect, logout and expiry remove the affected socket from presence counts. Another valid connection keeps the user online. | [Channel membership](../../apps/api/src/channels/channels.service.ts), [connections](../../apps/api/src/realtime/connections.service.ts), [typing integration](../../apps/api/test/integration/typing.ts), [presence integration](../../apps/api/test/integration/presence.ts), [session tests](../../apps/api/test/socket-session.spec.ts) |
| Presence uncertainty and races | Initial loading, error, omission, disconnection and new channel context remain unknown. Background refresh retains confirmed labels. A stale channel/socket reply cannot restore old state. | [Presence store tests](../../apps/web/src/app/features/chat/presence.store.spec.ts), [transport tests](../../apps/web/src/app/core/realtime-connection.spec.ts), [presence browser scenarios](../../e2e/presence.spec.ts) |
| Missed hints and membership omission | Drop real presence invalidations and filter any activity hints, close the writer, and observe a fresh query repair Online to Offline. After HTTP membership leave, another query changes Offline to unknown. No focus, visibility change, read write, navigation or reader reconnect triggers either repair. | [New timer-repair browser scenario](../../e2e/presence-repair.spec.ts), [new activity-revision regression](../../apps/web/src/app/features/chat/presence.store.spec.ts) |
| Accessible view and lifecycle | Text labels identify state beside authors; one aggregate status avoids per-message live announcements. Hidden views clear ephemeral state; destroyed views remove timers/listeners. Twenty channel changes do not accumulate DOM listeners. Long authors fit the mobile layout. | [View test](../../apps/web/src/app/features/chat/presence-view.spec.ts), [typing tests](../../apps/web/src/app/features/chat/typing.store.spec.ts), [responsive scenario](../../e2e/responsive.spec.ts), [presence screenshots](../../e2e/presence.spec.ts) |
| Conversation and session regressions | Distinct users converse without duplicates; reconnect/API restart recovers bounded history; leave blocks access; logout affects every tab of that session while another session survives. | [Conversation](../../e2e/conversation.spec.ts), [reconnection](../../e2e/reconnect.spec.ts), [session revocation](../../e2e/session-revocation.spec.ts) |
| No durable activity writes | Presence and typing integration assert zero message/read-cursor writes. No activity schema, replay queue, last-seen history or outbox is added. | [Typing integration](../../apps/api/test/integration/typing.ts), [presence integration](../../apps/api/test/integration/presence.ts) |

## Findings and verification method

Independent review and primary review found a missing browser proof for periodic
presence repair. Earlier scenarios covered reconnect, focus and late replies,
but did not demonstrate repair after a lost hint without another trigger.

The new scenario uses a real writer socket, the actual fifteen-second activity
interval and an unchanged reader connection. It drops real `presence:changed`
frames and filters any `activity:changed` frames, waits for outstanding presence
acknowledgements and
initial read writes to settle, and lets read-induced refreshes finish before
taking its baseline. It then requires a new presence query and checks unchanged
focus/visibility counters and cumulative read-write count. This prevents an old
request or a read completion from masquerading as timer repair. The membership
stage verifies omission becomes unknown, rather than an offline assertion.
No fake clock, application-state replacement or synthetic focus is used there.
The twenty-second assertion bounds each repair observation; it is not a latency
SLA or an extension of the server heartbeat deadline.

A focused unit test proves that the shared activity revision triggers another
snapshot. Removing that dependency temporarily makes the added test fail;
restoring the source returns the suite to green. No production change, schema,
dependency, retry setting, assertion or threshold is weakened by this checkpoint.

## Recorded execution

The integrated baseline's [CI run 39634584085](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39634584085)
passed Quality, Integration and Containers on `3b268bd`: **61 API, 137 Angular,
3 contract, 8 demo/reset and 5 Docker tests; 26 integration results in each
order; 35 Chromium E2Es and 6 repeated keyboard/navigation checks**. This is
baseline evidence, separate from the checkpoint runs recorded in the plan.

Local QA uses a rebuilt, isolated `handshake-verification` Compose project,
loopback port/origin 18093, a separate `cp6b_qa` database/role and its own subnet
and credentials. The production source is unchanged from the integrated base.
The added browser scenario passed three repetitions, and the combined activity,
conversation/restart, revocation and lifecycle regression block passed **8/8**.
The local quality checks passed **61 API, 138 Angular, 3 contract, 8 demo/reset
and 5 Docker tests**, lint, types, workspace builds and audit (zero vulnerabilities).
Executed checkpoint counts, cleanup and final-head CI are recorded in the
[implementation plan](../../tasks/plan.md) and this checkpoint's pull request.

## Scope limits

This verifies one local API instance, Chromium and application-managed membership
changes. Membership writes through the application are serialized with publication
and remove rooms. Deleting a recipient membership directly in SQL can leave a
stale room receiving typing until unsubscribe/disconnect: typing fanout rechecks
recipient sessions, not recipient memberships. This checkpoint does not certify
immediate recipient-room revocation for external SQL mutations. Presence reads
still recheck current membership, as their integration tests demonstrate.

Typing is a volatile hint with a receiver TTL, not proof of attention or message
delivery. Presence observes valid connections, with a real 25s/20s heartbeat for
silent loss; hidden/suspended browsers and event-loop delay can defer cleanup.
The UI queries at most 100 recent loaded authors, not a global roster. Shared
quotas across many views can produce unknown until retry succeeds. There is no
deployment, capacity benchmark, multi-instance guarantee, physical-device test
or exhaustive screen-reader/accessibility audit. P0 checkpoint closures remain
unchanged; CP6-C and capacity task 6.4a remain pending.
