# CP2-B — Message conversation and persistence checkpoint

Reviewed on 2026-10-12 against `main` commit `5eef159`, after PR #27 was merged.
**Verdict: verified for the current single-instance local scope.** The review
found and fixed an order-dependent test configuration failure. Application
behavior, schema and dependencies are unchanged.

## Acceptance evidence

| Criterion | Reviewed guarantee | Executable evidence |
| --- | --- | --- |
| Send and observe | Two independent signed-in users see the same canonical ID once, with author, server time and confirmation | `e2e/conversation.spec.ts` |
| View lifecycle | Closing/reopening twice does not duplicate delivery; owned listeners are removed and subscriptions renewed | Conversation E2E; `apps/web/src/app/features/chat/chat.store.spec.ts` |
| Persist before success | Message insertion and channel sequence increment commit together before ack/event | `apps/api/src/messaging/send-message.service.ts`; gateway; `apps/api/test/integration/messages.ts` |
| Rollback | A deferred PostgreSQL trigger fails at COMMIT; neither message, sequence increment nor success event survives | Message integration, real PostgreSQL transaction |
| Durable retry | Recreating all containers with the same volume preserves the complete canonical response to the original key | `e2e/persistence.spec.ts` |
| Basic duplicate protection | Five parallel socket retries return the same ID and produce one event; three independent service transactions create only once | Message integration; unique `(authorId, clientMessageId)` database index |
| Ordering | Unique `(channelId, sequence)`, positive BIGINT and exact decimal representation beyond MAX_SAFE_INTEGER | Migration constraints, message integration, chat-store ordering test |
| UI convergence | Ack before/after event converges on one ID; another author's client key does not clear the user's pending row | Chat-store tests |
| Authorization | Session determines author; membership checked under the channel lock; nonmembers and invalid sessions rejected | Message integration, proxy subscriptions E2E |
| Safe content | Strict bounded plain-text input; literal HTML in the browser; safe error envelopes | API validation tests, conversation E2E |

Persistence is verified by a database query and by retrying after container
recreation. It is not inferred from an in-memory browser row, and it does not
claim that a history endpoint or a reloadable conversation UI already exists.

## Review and resolved finding

Reviewed the message validator, migration, persistence service, gateway,
channel coordination, Angular connection/store/composer and their callers/tests.
The transaction retains the channel lock while checking membership, deduplicating
and incrementing the sequence. The local queue spans commit and publication.
Retries are authorized again and existing messages are not rebroadcast. Recipient
sessions and current rooms are checked before emitting content.

The client reuses one socket, serializes room changes and rejects work queued on
an older connection. View revisions ignore stale acknowledgements. Uncertain
delivery retains the request key/body; definite validation/conflict errors are
distinguished from unexpected failures. HTML is interpolated as text. Confirmed
live messages are bounded to 100; retry state lasts only for the current view.

**Resolved test blocker:** merged `main`'s
[CI run](https://github.com/MatteoMurcia/real-time-chat/actions/runs/38207342667)
failed all five connection tests, while its Containers job passed. Angular's
unit-test builder defaults to shared file execution. If `chat.store.spec.ts`
imports `RealtimeConnection` first, the cached module retains the real
`socket.io-client` import and the connection spec's module mock is ineffective.

A temporary Vitest sequencer forced chat-store tests before connection tests,
with one worker and file parallelism disabled. The original configuration
reproduced exactly **5 failed / 34 passed**. Enabling `isolate: true` in
`apps/web/angular.json` passed **39/39** under the same forced order. No assertion,
timeout, test body or production code was weakened. The temporary sequencer was
used only for diagnosis; normal test order remains unconstrained.

## Verification and provenance

- Application, contracts, migrations, E2E and Docker sources match PR #27 head
  `2fd0366`. The only executable configuration change is test-file isolation.
- PR #27's [final CI](https://github.com/MatteoMurcia/real-time-chat/actions/runs/38206991705)
  passed Quality and Containers: 31 API tests, 39 Angular tests, 3 contract tests,
  14 PostgreSQL integration results, 2 Docker tests, builds, audit and 10 E2Es.
- Merged `main`'s Containers job passed again during this checkpoint, including
  the compiled two-user conversation and full-container persistence checks.
  Its Quality failure is recorded above, not counted as a successful run.
- Local verification after the fix: forced-order Angular regression, normal
  workspace tests, lint, strict typechecks, production builds and Docker tests.
  The checkpoint PR's required Quality/Containers checks provide the final CI
  result, including fresh PostgreSQL integration and compiled browser tests.
- No working database changes or local migrations were performed. The existing
  `real-time-chat_postgres_data` volume is preserved. Diagnostic configuration
  and generated artifacts are excluded from commits.

## Limits and next gate

- One API process with process-local coordination and the synchronous adapter.
- Delivery is best-effort: a crash after commit can leave a saved message without
  an event/ack. This is database idempotency, not exactly-once delivery.
- Simultaneous reuse of a key across different channels can return INTERNAL_ERROR
  to the loser; recovery belongs to **3.1a**. Full timeout/late-ack reconciliation
  remains **3.1b**. A timeout does not prove loss.
- Only live messages are displayed. Closing/changing/reloading the view discards
  local rows, drafts and retry keys, not persisted data. History is **2.4a**;
  reconnect gap recovery is **3.2b**.
- Immediate idle expiry/logout socket closure remains **3.4a**, rate limiting
  **4.1a**. No multi-instance, load, TLS deployment, Firefox/WebKit or complete
  accessibility audit is certified. CP0-C and CP1-C remain pending.

Next task after human review and merge: **2.4a — Cargar historial por cursor**.
