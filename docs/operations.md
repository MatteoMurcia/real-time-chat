# Local diagnostics and health

This app runs locally in Compose; no hosted telemetry, deployment, metrics stack
or additional logging dependency is required. Shutdown/draining remains 4.4b.

## Health

| Endpoint | Meaning | Response |
| --- | --- | --- |
| `GET /api/health/live` | HTTP process is responding; does not query the database. | 200 `{"status":"ok"}` |
| `GET /api/health/ready` | A real `SELECT 1` can complete against PostgreSQL. | 200 `{"status":"ready"}` or 503 `{"status":"unavailable"}` |

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

## Verification

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
