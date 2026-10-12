# CP2-C — Conversation and history checkpoint

Reviewed on 2026-10-12 against `main` commit `89a23ef`, after PRs #29 and #30
were merged. This checkpoint covers the single-instance local conversation and
paginated history. It does not certify the recovery guarantees planned in stage 3.

**Verdict: verified for this scope.** Conversation, persistence, authorized
history, retry and reading-context checks pass. Owner review and merge remain pending.

## Review

Reviewed the history controller, cursor parser, query, channel access lock,
message persistence service, gateway publication, database indexes, Angular
history client/store, connection lifecycle and reading anchor, alongside their
integration and browser tests. No new blocking finding was identified for this
stage. No application, schema, dependency or test changes are required.

| Criterion | Reviewed guarantee | Executable evidence |
| --- | --- | --- |
| Conversation | Two independent users see one canonical message, including after remounting | `e2e/conversation.spec.ts` |
| Persistence and ordering | Commit precedes success; unique channel sequence; retries reuse the canonical ID | `apps/api/test/integration/messages.ts`, `e2e/persistence.spec.ts` |
| Authorized history | Session and membership checked on every page; no-store response; invalid/cross-channel cursors rejected | `apps/api/test/integration/history.ts`, `apps/api/test/history.spec.ts` |
| Stable pages | Exclusive sequence boundary within fixed H; 105 equal-timestamp messages across three pages despite a new write | History integration |
| Live/page convergence | Subscribe before snapshot; ID deduplication and exact BIGINT ordering; late responses cannot populate a different view | Chat-store tests, `e2e/history.spec.ts` |
| Recoverable failure | Retry keeps rows and cursor; revoked access clears the view | History E2E and store tests |
| Reading context | First visible message stays within 2 px while prepending; live events do not drag the reader down | `e2e/history-scroll.spec.ts`, 1280 and 390 px |
| Focus and notification | Focus survives the last page; new-message action returns to latest; history alone does not announce new traffic | History-scroll E2E |

History uses the existing `(channelId, sequence)` index with a bounded `limit + 1`
query, not OFFSET. The channel lock establishes the ordering of reads, writes
and membership changes. Cursors are validated boundaries, not authorization
tokens. Public projections exclude session/password data; the browser renders
message text through Angular interpolation.

Loaded pages remain in memory. Each inserted row currently sorts the accumulated
list, and finding the reading anchor scans loaded rows. This is acceptable for
the demonstrated local history; large-history performance is not certified.
Profile representative large histories before introducing batching or virtualization.

## Verification

- Fresh isolated PostgreSQL 18.6 database `checkpoint_test`, Compose project
  `chat-e2e`, compiled application at `http://localhost:18083`.
- `npm run test:integration --workspace @real-time-chat/api`: **15 passed**,
  including channels, membership, subscription races, message commit/rollback,
  duplicate protection and history authorization/snapshot pagination.
- `npm run test:e2e`: **13 passed in 59.1 seconds**, including two-user chat,
  container recreation, history/live races, recoverable errors and scroll context.
- [Merged-main CI](https://github.com/MatteoMurcia/real-time-chat/actions/runs/38289372325)
  passed Quality and Containers on the same application commit `89a23ef`.
- Application code matches reviewed `89a23ef`; this PR changes documentation only.
  The checkpoint PR's required Quality and Containers jobs provide fresh full
  typecheck, unit, build, audit, integration and browser verification.

## Remaining scope

- Cross-channel concurrent key conflict recovery: **3.1a**. Full uncertain-send
  and late-ack reconciliation: **3.1b**.
- Reconnect and commit-without-event gap recovery: **3.2a–3.3b**. Resubscribing
  today does not fetch missed messages in an already open conversation.
- Active closure of expired/revoked idle sockets: **3.4a**; rate limits: **4.1a**.
- Single API instance, best-effort events, no exactly-once/offline-first claim.
  Chromium only; no load, Firefox/WebKit, full assistive-technology or remote
  deployment certification. CP0-C and CP1-C remain pending.

## Schedule recalibration

Git records the first repository commit on October 7 and this stage's final merge
on October 12. PR #22 merged at October 11 09:15 UTC; PR #30 at October 12 18:12
UTC: about 33 elapsed hours between the first and last stage-2 merges. These are
calendar observations, not focused work hours; waiting, review and parallel work
cannot be separated from them. No timesheet or daily availability is recorded,
so extrapolating a delivery date from merge cadence would be misleading.

Remaining P0 planning allowance: stage 3 **13–18 h**, stage 4 **9–13 h**, stage 5
**6–9 h**, plus **2–4 h** for the pending earlier gates, then 20% contingency:
**36–53 focused hours**. These are provisional estimates, not measured velocity.
That corresponds to roughly **18–27 days at 2 h/day**, **9–14 at 4 h/day**, or
**5–7 at 8 h/day**; review waits and stage-6 extras are additional. Keep the full
scope and recalibrate after CP3-C using actual recorded session effort.

Next implementation task after owner review and merge: **3.1a — Resolver
reintentos concurrentes y conflictos**.
