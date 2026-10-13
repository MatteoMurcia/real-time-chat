# CP3-A — Uncertain sends and retry checkpoint

Reviewed on 2026-10-13 against `main` commit `4d67c77`, after PRs #32 and #33
were merged. Scope: concurrent idempotency and sender confirmation recovery on
the single-instance local application.

**Verdict: verified for this scope.** A committed message whose acknowledgement
is lost can be recovered with the original key without duplicating persistence
or the canonical UI row. Owner review and merge remain pending.

## Review

Reviewed the persistence transaction and unique-key recovery, gateway commit/
publication ordering, authorization, reducer, store attempt/view guards,
Socket.IO acknowledgement lifetime, UI states and their integration/unit/E2E
tests. No new blocking finding was identified. No application, schema,
dependency or permanent test changes are required.

| Criterion | Reviewed guarantee | Executable evidence |
| --- | --- | --- |
| Saved without a response | Suppress the actual gateway ack; independently query the persisted row before retry | `apps/api/test/integration/messages.ts` |
| Idempotent retry | Same author/key/channel/body returns the same canonical ID; one row and one publication | Message integration and `e2e/message-retry.spec.ts` |
| Concurrent conflicts | Ten equivalent requests converge; changed body/channel conflicts; losing transaction rolls back its sequence increment | Message integration and `message-idempotency.ts` |
| Authorized recovery | Membership is checked again after a unique-key race; leaving prevents retry from exposing the saved result | Idempotency integration with query barriers and revocation |
| Bounded retries | One automatic retry after 5 s while ready; another deadline leaves Unconfirmed and permits manual retry with the same request | Store fake-clock tests and retry E2E |
| Late confirmation | Ack/event order converges; old failures cannot replace a newer attempt or resurrect a confirmed row | Reducer/store tests; held acknowledgements in E2E |
| Definite rejection | Validation/conflict/rate-limit errors do not loop; current authorization failures clear the view | Store tests and real API validation rejection in E2E |
| Lifecycle | Offline sends are blocked; changing/destroying the view cancels UI deadlines and invalidates old responses | Store and connection tests |

A timeout is evidence only that confirmation did not arrive in time. The
integration test proves persistence by querying PostgreSQL independently; the
browser test drops both events and acknowledgements, then compares the final
canonical IDs with authorized HTTP history. Neither test infers data loss from
a timeout. Fault injection exists only in tests.

The implementation reuses the persistence service and a pure reducer. Recovery
after a unique-key violation performs an authorized read, not another insertion
or an unbounded transaction loop. Transport callbacks expire after 30 s per
attempt; the 5 s UI deadline is separate. No additional abstraction is needed.

## Verification

- Fresh isolated PostgreSQL 18.6 database `cp3a_test`, Compose project
  `chat-e2e`, compiled application at `http://localhost:18083`.
- `npm run test:integration --workspace @real-time-chat/api`: **16 passed**,
  including commit rollback, lost ack, concurrent keys and authorization races.
- `npm run test:e2e`: **14 passed in 1.5 minutes**, including late/lost
  confirmations, manual retry, real validation rejection and container recreation.
- Review mutation: temporarily inverted the reducer's attempt equality guard.
  **10 of 60 Angular tests failed**, including stale-attempt and rejection checks;
  the original file was restored before final verification.
- `npm run test --workspace @real-time-chat/web` after restoration: **60 passed**.
- Application code matches reviewed `4d67c77`; this checkpoint changes only
  documentation. Required Quality and Containers checks on the checkpoint PR
  provide fresh typecheck, unit, build, audit, integration and browser validation.

## Remaining scope

- Acks arriving beyond the 30 s transport window require another confirmation
  source, such as manual retry or history. Pending requests/keys are in memory
  and do not survive reload or closing the view.
- Events remain best-effort. Reconnection does not yet recover missed messages
  in an open conversation. Commit-without-event recovery belongs to **3.2a–3.3b**;
  this checkpoint does not claim exactly-once delivery or offline persistence.
- Single API instance and Chromium only. No load, multi-instance, other browser
  engine, full assistive-technology or remote deployment certification.
  CP0-C and CP1-C remain pending.

Next implementation task after owner review and merge: **3.2a — Servir
recuperación acotada por H**.
