# Local diagnostics and health

This app runs locally in Compose; no hosted telemetry, deployment, metrics stack
or additional logging dependency is required.

## Health

| Endpoint | Meaning | Response |
| --- | --- | --- |
| `GET /api/health/live` | HTTP process is responding; does not query the database. | 200 `{"status":"ok"}` |
| `GET /api/health/ready` | Not draining, and a real `SELECT 1` can complete against PostgreSQL. | 200 `{"status":"ready"}` or 503 `{"status":"unavailable"}` |

Both responses use `Cache-Control: no-store`. Readiness exposes no driver error,
database address or credentials. API container health uses readiness; the web
container's existing health check still verifies the proxied live endpoint.
Docker does not automatically restart an unhealthy container or reject requests:
readiness is a diagnostic signal, not a traffic gate.

The readiness query uses its own lazy Prisma/pg pool with **at most one extra
database connection per API instance**. Pool acquisition/connection, query read
and PostgreSQL statement timeouts are each 1,000ms; idle connections expire after
1,000ms. Acquisition and query can occur sequentially, so these are not a single
1,000ms HTTP deadline. The ordinary chat pool keeps its existing settings. Failed
queries release/destroy their client through pg; no abandoned `Promise.race`
queries accumulate. Both pools close on application destruction. A successful
probe checks database reachability, not schema drift, write capacity or every
dependency, and does not guarantee the next request will succeed.

## Find a failed request

Run `docker compose logs --no-log-prefix api web` for your development stack.
The API uses Nest's built-in JSON ConsoleLogger. Diagnostic fields live under
`message`; the envelope includes the timestamp, level and `Diagnostics` context.
For example:

```json
{"event":"http.request","requestId":"f9365054-956c-46d6-b4b3-0daf5e327afe","method":"POST","route":"/api/auth/login","status":401,"code":"UNAUTHENTICATED","durationMs":4}
```

The example shows the `message` object only. HTTP IDs are generated before body
parsing, returned in `X-Request-Id`, and reused in error bodies and the completion
log. Caller-supplied `X-Request-Id` is ignored. Nginx retains its own `requestId`
and records the API response ID as `apiRequestId`; use that field to join the
proxy and API records. Requests that never reach the API have no API ID.

Only registered route templates are logged, including Nest's static `*path`
fallback; parser failures use `unmatched`. URLs, path-parameter values and query
strings are excluded. Methods outside the small known set become `OTHER`.
Statuses and elapsed milliseconds distinguish slow requests from controlled
validation/authentication failures. `DATABASE_UNAVAILABLE` identifies a failed
readiness probe; `INTERNAL_ERROR` identifies an unexpected application failure.

## Find a failed message

Socket failure acknowledgements include their own server-generated `requestId`.
Search it in API records, then use `clientMessageId` to follow retries. Each send
attempt has a fresh request ID; its original client message key remains stable.
Only canonical UUIDv4 correlation IDs are emitted, including failures rejected
before message validation or while enforcing the quota. Invalid IDs are omitted.

- `message.send` with `outcome: created` means commit/publication completed.
- `message.send` with `outcome: duplicate` means an idempotent retry returned the
  existing message; it did not publish a second event.
- `socket.failure` has a safe public failure code. Sends also identify the stage:
  `authorize` (session/quota/input), `persist` (membership/conflict/transaction),
  or `publish` (the row committed but publication failed).

A failure at `publish` can already be saved. Retry with the **same** original key;
do not generate another ID. Existing HTTP recovery covers a commit/emission gap.
The API logs an outcome after its operation completes; it cannot prove that the
client received the acknowledgement. Engine.IO-level origin rejection remains
outside these application records; proxy status/timing still diagnose that path.

Normal completions use `log`, controlled failure codes use `warn`, and internal
or database-unavailable failures use `error`. No exception text/stack, request or
message body, cookie, password, token, email or full request/socket is serialized.
The explicit field allowlist also drops unexpected extra fields. UUID identifiers
are intentionally retained as correlation metadata; they are not message content.
Playwright traces are a separate **unredacted synthetic test artifact** governed
by [E2E diagnostics](e2e-ci.md), not by this application-log contract.

## If readiness fails

Check the live endpoint first. If live is 200 and ready is 503, inspect
`docker compose ps` and `docker compose logs db`, then find the failed readiness
request ID in API logs. Restore database availability and poll ready until 200;
existing sessions and idempotent retries should work again. Do not remove a
volume to repair availability. If live also fails, inspect API container status
and startup diagnostics instead. Raw PostgreSQL diagnostic commands/output may
contain connection information: keep them local and never paste credentials.

## Bounded shutdown

The production entrypoint handles `SIGTERM` and `SIGINT`. Use `docker compose stop api`
without overriding its timeout: Compose allows **12 seconds**, outside the API's
fixed **8-second** budget. The first signal synchronously withdraws readiness and
closes admission; repeated signals during draining do not reset the deadline.

- New HTTP work receives 503 and `Retry-After: 1`. The early gate runs before body
  parsing; a second admission check also rejects bodies that finish arriving later.
- New Engine.IO handshakes are rejected. Existing transports may finish polling or
  upgrade, but new socket operations fail safely without touching the database.
  This uses the existing `INTERNAL_ERROR` public code; it does not revoke a session.
- Already admitted controllers, authentication, subscriptions and sends are awaited,
  even if their HTTP client disconnects. Live stays 200 during draining; ready stays
  503 without starting new database probes. An earlier probe rechecks after its await.
- After admitted operations settle, Nest closes providers (including both database
  pools), sockets and HTTP. The process exits naturally. A stuck operation, failed
  resource cleanup or remaining referenced handle is bounded by exit **1** at 8s.

`ShutdownState.close(app)` is the coordinated entrypoint for programmatic shutdown
with active traffic. Plain Nest `app.close()` is appropriate for idle test cleanup
or startup failure; it does not perform this drain. Nest destroys providers before
transport disposal, so draining must precede that lifecycle, rather than run inside
a later shutdown hook. Do not add Nest signal hooks alongside the installed handlers.

`shutdown.start`, `shutdown.complete`, `shutdown.timeout` and `shutdown.failure`
share a generated request ID; pending-operation counts and elapsed time help locate
the failing phase. `shutdown.complete` means application disposal settled, not proof
that the operating system process exited. A stray handle can still cause a timeout.
Drain rejections use the internal diagnostic code `SHUTTING_DOWN`.

A message is acknowledged successfully only after its transaction commits and the
existing publication path settles. Shutdown adds no earlier success response. A
commit can still outlive its client's connection: after restart the browser reconnects
and recovers the visible channel from HTTP history/sync. Retry unconfirmed messages
with the same `clientMessageId`; existing idempotency returns the original row.

`SIGKILL`, host failure and power loss cannot drain. The deadline may terminate a
process during a transaction; PostgreSQL rolls back uncommitted work, while committed
work remains recoverable. There is no durable outgoing queue or exactly-once delivery
claim. Native Windows signal behavior is not certified; the supported shutdown path
is the Linux Node process in Compose. No deployment or multi-instance coordination
is introduced.

## Diagnostics verification — 4.4a

`apps/api/test/observability.spec.ts` verifies HTTP IDs, parser/404/500 failures,
privacy canaries, readiness failure/recovery and actual parseable JSON output.
An intentional mutation removing the UUID guard failed its privacy assertion;
the guard was restored and unit tests/build passed. The existing quota integration
fixture checks correlation on the real 31st send rejected before validation.

`e2e/diagnostics.spec.ts` runs only against a verified disposable Compose project.
It verifies real API/proxy records and privacy, pauses PostgreSQL with concurrent
probes while live remains responsive, stops it and checks a failed send, then
restores it and retries the same key. Teardown is protected by `finally` and never
targets the primary development volume.

[CI 39218443803](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39218443803)
first passed both integration orders, all 26 E2Es and six repetitions. Quality
identified an absent upstream header represented as an empty string where the
Docker log contract expected `-`. `27d0e9b` adds an explicit Nginx map: only a
canonical API UUID is retained; every absent/invalid value becomes `-`. The
original Docker assertions were preserved, rather than relaxed.

[CI 39219045210](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39219045210)
on `27d0e9b` passed **Quality, Integration and Containers**: 47 API, 103 Angular,
three contract tests, five Docker checks, 21 integration results per order,
26 E2Es and six repeated usability executions. Build and dependency audit passed
with zero vulnerabilities, skips or retries. The outage test successfully warmed
the probe, paused PostgreSQL, received four concurrent 503s plus a live 200 within
its 4,500ms budget, restored readiness, stopped the database, correlated the failed
send and restored the original-key retry into exactly one history row.

HTTP/proxy IDs, created/duplicate/conflict/forbidden outcomes, malformed-ID
omission and private canaries all passed against real JSON container logs.
The quota fixture separately proves the rate-limited acknowledgement's ID and
client key remain correlated before validation. Existing rollback/commit tests
remain intact. Cleanup and diagnostic uploads passed; the
[E2E report artifact](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39219045210/artifacts/12170569073)
retains this run for seven days.

Independent review and parent review found no remaining required issues. Local
lint, types, unit tests and build passed. Docker local remains unavailable, so
real PostgreSQL/Nginx/container evidence comes from Linux CI. PR #50 is left for
owner review/manual merge. CP0-C, CP1-C and CP4-C remain pending; 4.4a does not
certify shutdown, draining, production load or every transport-level rejection.

Configuration references: [Nest JSON logging](https://docs.nestjs.com/techniques/logger#json-logging),
[pg timeout options](https://node-postgres.com/apis/client),
[Compose health dependencies](https://docs.docker.com/compose/how-tos/startup-order/).

## Shutdown verification — 4.4b

`apps/api/test/shutdown.spec.ts` covers admission, idempotent release, aborted
HTTP controllers, late bodies, readiness races and authentication races. Removing
the readiness recheck after its database await deliberately produced 200 instead
of the required 503; restoring it returned all four shutdown tests to green.

`apps/api/test/integration/shutdown.ts` forks compiled Linux Node processes against
the isolated database. Deferred PostgreSQL triggers hold a real commit or force a
rollback, with `pg_blocking_pids` proving the barrier was reached before SIGTERM.
Readiness, live, new-work rejection and repeated signals are checked while held.
Separate test-entrypoint faults hold a send forever or leak a referenced interval;
both must exit 1 inside the budget. Graceful cases exit naturally with 0. Every case
restarts and retries its original key: one row, and the original ID if committed.
The parent bounds waits independently so a broken deadline reaches cleanup.
These faults and triggers are test-only; the runtime image has no fault switches.

`e2e/shutdown.spec.ts` verifies Compose project labels before touching disposable
containers. It holds a real deferred commit, observes zero visible rows and no
success acknowledgement, sends SIGTERM, verifies rejection while draining, releases
the commit and requires exit 0. The browser loses the real acknowledgement/event;
HTTP recovery is withheld until restart. Automatic reconnection must produce one
canonical row and no pending duplicate, then a same-key retry returns its exact ID.
Finally releases the database gate, drops its trigger and restarts the API.

[CI 39264903128](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39264903128)
on `cfe6bf8` passed all three jobs: **51 API, 103 Angular, three contract tests,
five Docker checks, 22 integration results in each order, 27 Chromium E2Es and
six usability repetitions**. Zero skips/retries or audit vulnerabilities. Both
process-shutdown runs passed, as did the real-container/browser scenario. Database
cleanup, stack teardown and report uploads passed. Independent and parent review
findings were corrected before opening PR #51; the parent inspected the CI logs.
Docker Desktop remains unavailable locally, so Linux CI supplies the real runtime
evidence. No primary environment/volume was modified, and no deployment was made.
CP0-C, CP1-C and CP4-C remain pending.

References: [Nest lifecycle order](https://docs.nestjs.com/fundamentals/lifecycle-events),
[Node HTTP close](https://nodejs.org/api/http.html#serverclosecallback),
[Socket.IO close](https://socket.io/docs/v4/server-api/#serverclosecallback),
[Compose stop grace](https://docs.docker.com/reference/compose-file/services/#stop_grace_period).
