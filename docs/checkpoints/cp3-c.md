# CP3-C — Reliability and session lifecycle checkpoint

Reviewed on 2026-10-14 against `main` commit
`475f0e68506998e089728a8d33aca04c343dec52`, with 3.4a integrated by PR #40.
Scope: the complete suite through stage 3, lost responses, API restart,
connected gap recovery and session revocation/expiry in the local application.

**Verdict: verified for this scope.** Fresh checks pass with canonical message
IDs, bounded recovery and session closure. Owner review and merge of this
checkpoint remain pending. CP0-C and CP1-C remain pending.

## Review and demonstrations

Reviewed persistence/idempotency, channel locks and ordering, snapshot/sync
queries, gateway authorization/publication, connection timers, browser session
lifecycle, reducer/store cancellation and their callers, contracts and fixtures.
No blocking defect was found; no application, schema, dependency or permanent
test changes are required.

| Criterion | Guarantee and fresh executable evidence |
| --- | --- |
| Lost send response | `messages.ts` suppresses the real gateway ack after commit and independently reads PostgreSQL; retry returns the same ID. `message-retry.spec.ts` drops events/acks and reconciles late/manual confirmations with the original key and exactly two saved rows. |
| Idempotency and order | Integration checks concurrent equivalent keys, changed body/channel conflicts, authorization after a unique-key race, rollback of counter/row and exact decimal BIGINT sequences. Commit precedes emission and success. |
| Fixed H and safe C | Sync integration holds commit/rollback and writes between pages. Store/client tests keep H fixed and advance C only after a complete validated page; live events and older history cannot advance C. |
| API restart | `reconnect.spec.ts` disconnects the browser, saves 105 messages, restarts the isolated API and recovers three pages with exact canonical IDs, fixed H and retained draft; a 503 recovery failure can be retried. |
| Missing emission/delivery | `commit-emission.ts` suppresses server emission after a real commit while a second user's receiver stays connected. `sync-gap.spec.ts` instead drops 105 already-emitted events in the browser proxy; recovery under live traffic converges once and a subsequent interval is empty. |
| Initial-load races | Store race tests and `channel-races.spec.ts` cover events around H and A-to-B-to-A responses/acks without stale state resurrecting a closed view. |
| Revoked/expired idle sockets | Integration closes two sockets on logout and two idle sockets at a real short database expiry, preserves another session and holds the handshake read and post-registration recheck across revocation. Reconnect cannot resurrect the revoked session; leaving offline denies the replacement subscription. |
| Timer and client cleanup | API fake-clock tests check one timer per session, the absolute deadline, last-socket cleanup and module destruction. Angular tests cover session expiry, stale restoration, pending logout, recovery/send timer cancellation, listeners and view destruction. |
| Privacy after session end | `session-revocation.spec.ts` removes conversation and draft from a connected shared tab and rejects an offline reconnect while another session can still send. `session.spec.ts` verifies HttpOnly cookies, empty client storage and the lost-logout-response retry. Public message projections contain only author ID/name, excluding email, password/session data. |

The timer is not the only access check: operations authenticate again and
publication filters current unexpired session records even if a socket is kept
open in the test. Membership, rooms and publication share the channel queue;
database locks order membership changes and message transactions. The queue,
revocation notification and synchronous Socket.IO adapter are process-local.

Lost logout response plus lost notification is deliberately tested separately:
the browser keeps its uncertain sign-out error until retry confirms the invalid
session; the server has already revoked access. The commit-without-emission
fixture is deterministic suppression, not a process killed at the exact commit
instruction. Fixtures and `dist-test` are absent from the runtime API image.

## Fresh verification

Host toolchain: Node **24.21.0**, npm **12.1.0** on Windows/PowerShell.
Fresh PostgreSQL **18.6**, database `cp3c_test`, Compose project `chat-e2e`,
compiled application at `http://localhost:18083`. Initial port/project collision
checks passed. Temporary credentials live only in ignored `.git/cp3c.env`.
Integration finished before E2E; neither suite ran concurrently against the
database. All following results were run for this checkpoint, not inherited
from 3.4a or counted from Docker's cached stages.

| Command/check | Result | Local evidence under `.git/cp3c-logs/` |
| --- | --- | --- |
| `npm run lint` | Passed, zero warnings | `lint.log` |
| `npm run typecheck` | All workspaces passed | `typecheck.log` |
| `npm test` | 39 API, 85 Angular across 11 files, 3 contracts passed; no skipped tests | `unit-tests.log` |
| `npm run test:docker` | 2 passed | `docker-tests.log` |
| `npm run build` | All workspaces passed; web initial bundle 412.66 kB, estimated transfer 107.64 kB | `build.log` |
| `npm audit --audit-level=high` | Zero vulnerabilities | `audit.log` |
| Isolated Compose build/start with `compose.host.yaml` | Passed; services healthy and migration exited 0; build stages cached | `compose-build.log` |
| `npm run test:integration --workspace @real-time-chat/api` with isolated `TEST_DATABASE_URL` | 20 results passed, including parent result, in 15.1 s | `integration.log` |
| `npm run test:e2e` with isolated base URL/project/env file | 18 Chromium tests passed in 2.1 min; one worker, zero retries | `e2e.log` |
| Timer cleanup mutation | Removing last-socket `clearTimeout` failed 1 of 5 lifecycle tests, expecting one cleanup call and observing zero | `mutation-timer.log` |
| Restore and recompile after mutation | Original source bytes restored; 39 API tests passed; application diff empty | `restored-compile.log`, `restored-api-tests.log` |
| Runtime container inspection | Test, fixture and `dist-test` paths absent, command exited 0 | `runtime-exclusion.log` |

The full E2E suite recreates all four containers while retaining the isolated
volume, verifies accounts/session and message ID after recreation, then restarts
the API again for recovery. Its final stack uses `compose.yaml` without the host
database override, so PostgreSQL is no longer exposed on port 15491. The healthy
isolated stack is retained temporarily for final reviewer inspection; cleanup
will be recorded before PR creation. The primary
`real-time-chat_postgres_data` volume and root `.env` were not modified.
Local logs are ignored, not shipped with the checkpoint. GitHub Quality and
Containers checks for the checkpoint PR remain to be run after PR creation.

## Remaining scope and limits

- Persistence is deduplicated; delivery is best-effort. There is no exactly-once
  transport guarantee, outbox or durable offline queue. Saved messages converge
  through authorized retry/history/sync while the user remains authorized.
- One API instance and Chromium/HTTP local only. No multi-instance, load,
  Firefox/WebKit, full assistive-technology, remote deployment or TLS
  certification. Rate limits and integral quality work remain in stage 4.
- Pending keys, rows, cursors and drafts live in memory; closing/reloading
  discards client state. Hidden tabs pause recovery. Event-loop/browser
  scheduling, channel lock contention and network failures prevent a guaranteed
  expiry/recovery latency; already accepted operations and transmitted events
  cannot be retracted.

## Schedule recalibration

Stages 0–3 are implemented through merged PR #40; this checkpoint still needs
owner review/merge. CP0-C and CP1-C remain open. No timesheet or daily
availability is recorded, so merge timestamps cannot establish focused effort
or velocity and no delivery date is committed.

Remaining P0 allowance retains the prior estimates: stage 4 **9–13 h**, stage 5
**6–9 h**, plus **2–4 h** for the earlier gates, giving **17–26 h** before
contingency. Applying 20% gives **20.4–31.2 h**, rounded upward to **21–32
focused hours**. This is provisional planning, not measured performance and
does not reduce scope. It corresponds approximately to **11–16 days at 2 h/day**,
**6–8 at 4 h/day**, or **3–4 at 8 h/day**; review waits and stage-6 extras are
additional. Record actual effort in future sessions to refine the estimate.

Next implementation task after owner review and merge: **4.1a — Acotar tráfico
y entradas**. No stage-4 implementation is included in this checkpoint.
