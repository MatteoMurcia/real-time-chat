# CP2-A — Channel permission checkpoint

Reviewed on 2026-10-11 against `main` commit `f726fde`, after PR #24 was merged.
**Verdict: verified for the current single-instance local scope.** No blocking
findings and no application, schema or dependency changes were required.

## Acceptance evidence

| Boundary | Reviewed behavior | Executable evidence |
| --- | --- | --- |
| HTTP identity | Cookie session determines the user; forged user IDs are rejected | `apps/api/test/integration/membership.ts` |
| Mutation protection | Exact origin and session-bound CSRF; missing/revoked session rejected | Membership and identity integration cases |
| Membership | Repeated PUT/DELETE are idempotent; creator has no permanent access privilege | Membership integration, persisted row and policy assertions |
| Socket identity | Handshake cookie revalidated on each operation; malformed payloads and supplied identity rejected | `apps/api/test/integration/subscriptions.ts` |
| Subscription | Nonmember denied; subscribe does not join; unsubscribe does not delete membership | Subscription integration |
| Active channel | Successful subscribe replaces the previous room; disconnect clears rooms; reconnect requires a new subscription | Subscription integration, real Socket.IO adapter inspection |
| Leave | Both sockets of the leaving user are removed before HTTP success; another user's room survives | Subscription integration and `e2e/subscriptions.spec.ts` |
| Subscribe first | A subscription admitted before leave is subsequently removed | Integration barrier holds the real channel row lock while DELETE queues |
| Leave first | A queued subscription sees missing membership and receives FORBIDDEN | Same barrier test with the operations reversed |
| Failure | Database failure does not falsely remove membership/rooms; socket errors expose no private database detail | Subscription and membership integration |

The two race cases use explicit entry/release/queue barriers, not delays or a
probabilistic stress loop. Assertions inspect actual server rooms after the HTTP
response and check acknowledgements. Existing negative-control evidence from
2.2b confirms that omitting room removal makes this integration fail; that
mutation was not repeated or retained during this checkpoint.

## Code review

Reviewed the HTTP controller, membership service, shared access policy,
Socket.IO gateway, connection index, origin/CSRF/session checks and their tests.
Identity comes from the session, SQL values are parameterized and the membership
query uses the composite key. No new dependency or generalized permission engine
is involved. Room removal scans only the leaving user's connected sockets.

The local queue covers `transaction → commit → room change → response`, rather
than releasing coordination at commit. Both membership mutations and subscription
operations enter that queue. The database row lock gives dependent operations a
consistent channel boundary; the synchronous in-memory adapter completes room
changes before the queue releases. Queues release after failure and their map
entries are removed when idle; user socket sets are removed on disconnect.

## Verification performed

- Fresh isolated PostgreSQL database `cp2a_test` in Compose project `cp2a-review`.
- `npm run test:integration --workspace @real-time-chat/api`: **13 passed**, zero
  failures/skips, including both deterministic races and HTTP/session boundaries.
- Confirmed that merged application, contract, E2E and Docker sources match the
  previously verified PR #24 head `52f8a10` (no source diff).
- PR #24's [CI run](https://github.com/MatteoMurcia/real-time-chat/actions/runs/38147055873)
  passed Quality and Containers: 30 API tests, 27 Angular tests, contract tests,
  strict checks, builds, audit and all 9 E2Es against the compiled proxy stack.
- The merged `main` [CI run](https://github.com/MatteoMurcia/real-time-chat/actions/runs/38147333820)
  also completed successfully during this checkpoint.
- Removed the temporary database, network and credentials after verifying the
  Compose ownership label. Preserved `real-time-chat_postgres_data`.

## Limits and next gate

This verifies channel membership and subscriptions, not future message/history
authorization. Channels are open and their directory remains discoverable after
leaving. Membership does not imply a socket subscription.

- One API process and the synchronous in-memory adapter; multiple instances need
  distributed coordination and revocation, not merely a shared room adapter.
- Revoked/expired sessions fail on the next operation. Immediate logout
  disconnection, idle expiry and delivery-time filtering remain **3.4a**.
- No message delivery exists yet. **2.3a** must preserve this ordering when
  authorizing writes and emitting after commit; a room never replaces a check.
- Conversation UI is **2.3b**, rate limiting **4.1a**. No load test, TLS deployment
  or multi-instance test was performed. CP0-C and CP1-C remain separately pending.

Next task after human review and merge: **2.3a — Persistir mensajes con orden e
idempotencia básicos**.
