# CP6-A — Read consistency across sessions

Reviewed on **2026-10-21** against integrated `main`
`3b895a2cca04a6496d0709ad7dca80c9d15a592e`, after 6.1a/PR #60 and
6.1b/PR #61. The checkpoint covers persisted read progress, unread counts,
cross-session synchronization and the conditions for automatic marking.

**Verdict: verified for the single-instance local scope.** The owner confirmed
on 2026-10-20 that only messages from other people count. A user's independent
sessions share a monotonic cursor; another user's progress remains separate.
Owner review and merge of this checkpoint remain manual.

## Acceptance evidence

| Criterion | Reviewed assertion | Executable evidence |
| --- | --- | --- |
| Count contract | Count committed foreign-author messages after the authenticated user's cursor; nonmembers receive null, not a private count. Joining includes earlier history and rejoining retains progress. | [SQL and membership scope](../../apps/api/src/channels/channels.service.ts), [read-cursor integration](../../apps/api/test/integration/read-cursor.ts), [browser counts](../../e2e/unread.spec.ts) |
| Monotonic progress | Concurrent sessions converge on one maximum. Stale valid requests cannot lower it; a future, missing or foreign-channel sequence is rejected. | [PostgreSQL integration](../../apps/api/test/integration/read-cursor.ts), [sequence validation](../../apps/api/test/read-cursor.spec.ts) |
| Authorization and commit boundary | Authentication, membership and CSRF protect writes. Observed PostgreSQL lock waits order reads against leave and commit/rollback; a rolled-back message cannot be marked read. | [Controller](../../apps/api/src/activity/activity.controller.ts), [transaction](../../apps/api/src/activity/read-cursor.service.ts), [integration barriers](../../apps/api/test/integration/read-cursor.ts) |
| Distinct browser sessions | Two independently logged-in contexts have different cookies. Reading in one clears both counts; a stale PUT from the other returns the stored maximum. Reload retains progress and logging out one session preserves delivery to the other. | [New independent-session scenario](../../e2e/read-consistency.spec.ts) |
| User isolation | Alice's own message counts for Bob, not Alice. Bob's cursor remains zero after Alice reads; Bob's own messages do not increase his count. | [Independent-session scenario](../../e2e/read-consistency.spec.ts) |
| Visible and reached | Hidden reception and a message below the reader do not advance progress. Only a fully visible confirmed-message end in the current channel can mark a recovered sequence. | [Unread browser scenario](../../e2e/unread.spec.ts), [observer guard test](../../apps/web/src/app/features/chat/chat.spec.ts) |
| Recovery boundary | Live events and acknowledgements do not move the HTTP recovery boundary. Opaque cursors remain opaque; a separate recovered message sequence bounds read marking. | [Store test](../../apps/web/src/app/features/chat/chat.store.spec.ts), [observer test](../../apps/web/src/app/features/chat/chat.spec.ts), [bounded gap browser test](../../e2e/sync-gap.spec.ts) |
| Lost invalidation | A real read commits while the other session's activity frames are dropped. Its directory count converges through a later HTTP read with no focus/visibility change, navigation or reconnect. | [New timer-repair scenario](../../e2e/read-consistency.spec.ts) |
| Errors and stale responses | Failed/malformed cursor responses remain retryable; counts are not cleared optimistically. Old directory responses cannot undo leave. Explicit logout survives a concurrent directory 401 and a late socket-end event. | [Activity tests](../../apps/web/src/app/core/activity.service.spec.ts), [directory tests](../../apps/web/src/app/features/channels/channel-list.spec.ts), [session tests](../../apps/web/src/app/core/session.store.spec.ts), [logout E2E](../../e2e/unread.spec.ts) |
| Persistence and reset | A retained volume preserves the cursor through container recreation; seed reruns retain it; guarded demo reset clears it before opening a conversation again. | [Persistence E2E](../../e2e/persistence.spec.ts), [seed integration](../../apps/api/test/integration/demo-seed.ts), [demo maintenance](../../e2e/demo-maintenance.spec.ts) |

The cross-session browser scenario adds evidence missing from 6.1b: that test
uses two reader pages sharing one cookie. The new test uses two logins for Alice
and a third context for Bob. It drops actual `activity:changed` WebSocket frames,
then observes the real visible-tab interval and authoritative HTTP count repair.
Focus/visibility counters remain unchanged, the socket connection count stays
one and no fake clock or application state override is used in that scenario.
The interval is configured at 15 seconds; its phase is not reset by a message.
The test allows 20 seconds for convergence, not a production timing guarantee.
The separate hidden-tab test explicitly controls `document.visibilityState`
because headless Chromium keeps its pages visible.

## Findings resolved

Independent review and the primary review found two evidence gaps: browser
count synchronization across genuinely distinct sessions, and timer-driven
repair without a focus trigger. The new scenario closes both.

The review also found a directory edge case: an insert before a full slug page
can push a displayed row outside the next background result. That row previously
lost its badge without explanation. The checkpoint's minimal correction marks
counts unavailable using the existing notice, preserves row order/focus, and
lets manual **Refresh channels** rebuild the page. A 50-row regression failed
before the correction and passed afterward. This does not claim continuously
stable directory pagination during inserts.

The [read contract](../read-cursors.md) no longer describes the implemented UI
and counts as future work. No Critical or Required finding remains. There are
no schema, dependency, transport or deployment changes, and no assertion,
threshold or retry setting was weakened.

## Recorded execution

[Integrated baseline CI 39475985931](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39475985931)
passed Quality, Integration and Containers on `3b895a2`: **55 API, 117 Angular,
3 contract, 8 reset-guard and 5 Docker tests; 24 integration results in each
order; 31 Chromium E2Es and 6 keyboard/navigation repetitions**. Existing
integration/persistence evidence above was reviewed from that run; it is not
presented as a newly repeated standalone local database suite.

Local checkpoint executions on 2026-10-20 used a fresh, ownership-checked
`handshake-verification` stack, loopback port/origin 18090 and a separate
database/role, password and subnet. Build/migrations/startup completed through
Compose. The new scenario passed once, then **3/3 repetitions** against the
baseline application. After rebuilding the pagination correction in `dab5ccd`,
the new scenario, both unread scenarios and responsive/lifecycle scenario
passed **4/4**. The final local Angular suite passed **118/118** and lint passed
without warnings. These are automated Chromium checks, not human usability tests.

The [checkpoint PR #62](https://github.com/MatteoMurcia/real-time-chat/pull/62)
is the record for final combined-branch CI on its exact head,
including the newly added scenario in the complete browser suite. Temporary
database credentials stayed outside versioned files. The QA database identity,
mounted volume and Compose ownership were checked before removing the disposable
stack, its volume and credential file. The ordinary `.env` and development
database were preserved.

## Limits and next step

Read means **through this reached message**, including earlier unloaded history;
it is not proof of human attention or an individual-message receipt. A window
covered by another application may still be document-visible. Expired/revoked
sessions and nonmembers cannot use the protected cursor API.

Invalidations and connection tracking remain process-local. A lost signal is
repairable while visible, authenticated and connected to the database; there is
no durable notification, wall-clock delivery SLA, outbox, multi-instance or
measured capacity claim. Exact counts have not been load-tested. No remote
deployment, physical-device, Firefox/Safari or exhaustive accessibility audit
was performed. Directory page composition still requires manual refresh when
concurrent inserts displace displayed rows; unavailable counts are explicit.

**CP6-A is complete for this scope.** The next planned task is
**6.2a — Indicar escritura efímera**; typing and presence are not part of this
checkpoint. The owner reviews and merges the PR.
