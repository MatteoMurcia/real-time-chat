# CP3-B — Bounded recovery checkpoint

Reviewed on 2026-10-13 against `main` commit `fbe0623`, after PRs #35 and #36
were merged. Scope: recovering the visible conversation after a network
interruption and API restart on the single-instance local application.

**Verdict: verified for this scope.** Recovery restores 105 missed messages in
three pages, in canonical order without duplicate rows. Owner review and merge
remain pending.

## Review

Reviewed the HTTP controller, cursor parser, channel locking and authorization,
bounded query, browser pagination validation, store lifecycle, reducer consumers
and integration/unit/E2E fixtures. No blocking finding was identified. No
application, schema, dependency or permanent test changes are required.

| Criterion | Reviewed guarantee | Executable evidence |
| --- | --- | --- |
| Committed H | The channel lock waits for pending writes to commit or roll back before capturing H | `message-sync-races.ts` observes actual PostgreSQL lock waits |
| Finite interval | Pages retain H despite new writes; final cursor reaches H, including empty intervals | `message-sync.ts`: 105 rows, three pages, writes between pages |
| Authorized reads | Session and membership checked on every request; malformed, foreign and future cursors rejected | HTTP integration and cursor parser tests |
| Exact ordering | Decimal BIGINT sequences remain exact; ascending pages use the existing channel/sequence index | Integration above the safe integer range and client validation tests |
| Safe progress | Merge a validated page before advancing C; events and older history never advance C | Store and sync client tests |
| Lifecycle | One active recovery; focus, visibility, reconnect and periodic checks; cancellation on hide, disconnect, view change and destruction | Store fake-clock and cancellation tests |
| Recoverable failure | Keep loaded rows and last completed C after a transient failure; allow retry; authorization failure clears the view | Store tests and browser 503/retry scenario |
| Restart recovery | Disconnect browser, send 105 messages, restart API, reconnect and compare ordered canonical IDs | `e2e/reconnect.spec.ts` |

The restart scenario uses a separate authenticated Socket.IO client under the
same user to send while the browser is offline. It compares every displayed ID
with the successful send acknowledgements, retains the draft, checks that both
continuation requests share H, then exercises a failed focus recovery and retry.
Existing conversation E2E separately covers two independent users. Fault
injection remains confined to tests.

## Verification

- Fresh isolated PostgreSQL 18.6 database `cp3b_test`, Compose project
  `chat-e2e`, compiled application at `http://localhost:18083`.
- PostgreSQL integration: **18 passed**, including fixed-H traffic and held
  commit/rollback races.
- Review mutation: temporarily inverted the client's subsequent-page H equality
  check. **2 of 74 Angular tests failed**; the original file was restored.
- Angular unit tests after restoration: **74 passed** across 10 files.
- Chromium E2E: **15 passed**, including the three-page restart recovery,
  transient recovery failure, history, send retries and container recreation.
- Compose build/start succeeded; cached build stages are not counted as fresh
  unit runs. Required Quality and Containers checks on this checkpoint PR provide
  fresh typecheck, unit, build, audit, integration and browser validation.
- Application code matches reviewed `fbe0623`; the checkpoint changes only
  documentation. The primary development database and `.env` are preserved.

## Remaining scope

- Initial-load/event races and A-to-B-to-A scenarios remain in **3.3a**;
  deliberate commit-without-emission certification remains in **3.3b**.
- Cursors and pending requests are in memory. Hidden tabs pause recovery;
  browser scheduling, failures and channel lock contention prevent a guaranteed
  recovery latency. An invalid cursor resets the local conversation snapshot.
- One API instance and Chromium only. No load, multi-instance, other browser
  engine, full assistive-technology or remote deployment certification. This
  does not promise exactly-once delivery. CP0-C and CP1-C remain pending.

Next implementation task after owner review and merge: **3.3a — Resolver
carreras de carga inicial y eventos**.
