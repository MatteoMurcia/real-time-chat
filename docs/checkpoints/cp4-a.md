# CP4-A — Entry points and credential boundaries

Reviewed on **2026-10-17**, starting from `origin/main`
`d9a73b3282796d33d1382627be65dc3bc245af30`, with 4.1b integrated by PR #43.
Scope: all current HTTP and Socket.IO entry points, server-side permissions,
input bounds, public projections, and credentials in responses/service logs of
the compiled local application. Evidence was collected on 16–17 October.

**Verdict: verified for this scope.** Two logging defects were reproduced and
corrected. This checkpoint still requires independent parent review and the
owner's manual PR review/merge. CP0-C and CP1-C remain pending; next task is 4.2a.

## Complete entry-point inventory

The inventory comes from all five controllers, the gateway and Engine middleware,
not from visible UI controls: **13 HTTP routes, three namespace events, polling
and WebSocket handshake/upgrade requests**. Shared services and their callers,
validators, contracts, database projections, proxy/configuration and browser
rendering/storage were read alongside the executable evidence.

| Entry point | Server boundary and executable evidence |
| --- | --- |
| `GET /api/health/live` | Public constant liveness response; `health.spec.ts` and application integration. No identity or input is echoed. |
| `GET /api/auth/csrf` | Exact origin or same-origin Referer required; short-lived signed pre-auth cookie/token pairing. Registration tests reject forged/expired/mismatched tokens and foreign origins. |
| `POST /api/auth/register`, `POST /api/auth/login` | Pre-auth CSRF/origin, JSON content type, bounded allowlisted body, IP quota. Registration/password/session tests plus integration cover unknown fields, normalization, malformed/oversized JSON, duplicate accounts and generic authentication errors. |
| `GET /api/auth/me` | Cookie-only live session; malformed, duplicate, expired, revoked cookies and a valid token in query are rejected. Session integration checks exact public fields and token hashing. |
| `GET /api/auth/session/csrf` | Live cookie plus origin; token bound to session and short expiry. Logout tests cover missing/expired sessions and a token from another session. |
| `POST /api/auth/logout` | Live cookie plus session-bound CSRF/origin; revokes only that session and closes its sockets. Integration/session E2E cover other sessions, idle expiry, offline tabs and response-loss recovery. |
| `GET /api/channels` | Live cookie, bounded canonical discovery cursor/limit and allowlisted query. Registered users may discover open channels; `channels.spec.ts` and channel integration verify projection/pagination. |
| `POST /api/channels` | Live cookie, user quota, session CSRF/origin, JSON/allowlisted name/slug; atomic creator membership. Channel integration rejects forged origins/tokens, extra identity and invalid input without writes. |
| `PUT`, `DELETE /api/channels/:id/membership` | Live cookie and session CSRF/origin; validated ID, no body/query. Actor comes from session; join/leave are ordered against dependent operations. Membership/subscription integration checks rejected requests have no effect and leave removes rooms. |
| `GET /api/channels/:id/messages`, `GET /api/channels/:id/messages/sync` | Live cookie and membership under channel lock; bounded canonical channel-bound cursors and limit ≤100. History/sync tests reject borrowed/constructed/cross-channel cursors without access; recovery keeps H fixed. |
| Engine.IO polling and WebSocket, including subsequent polling and upgrade | Origin middleware runs on Engine requests; namespace authentication reads only the cookie. Real clients cover invalid origins, auth/query identity spoofing, expiry/revocation and connection quota/abort cleanup. |
| `channel:subscribe`, `channel:unsubscribe` | Exact one-field payload, valid channel ID and live session recheck. Subscribe also requires membership before joining; unsubscribe only removes the caller's own room and needs no membership. Subscription integration covers malformed data, missing access and subscribe/leave races. |
| `message:send` | User quota before queue/DB, strict payload, live session and membership under lock; author always comes from session. Message integration verifies spoofed identity rejection, canonical ack/event/row, rollback, idempotency and filtered recipients. |

HTTP JSON is bounded to 8 KiB and Engine payloads to 16 KiB; text is bounded to
2,000 Unicode code points with invalid encoding/NUL rejected. Default quotas,
trust of the explicit proxy peer, spoofed XFF, connection slots and oversized
polling/WebSocket payloads are exercised by `traffic-limits.ts`. Only the
high-volume recovery/E2E fixtures raise four attempt limits to 1000; a separate
integration app tests real defaults, retaining five connections per session.
Unknown HTTP routes return safe errors; no additional application socket event
handler or runtime test endpoint exists.

Prisma structured operations and the parameterized channel-lock query carry
untrusted data; the application has no raw SQL string concatenation. Public user,
channel and message projections exclude password/session hashes and tokens.
Angular interpolation renders executable-looking HTML literally in live and
persisted messages; existing direct-client E2E bypasses the UI for access tests.
Security headers, reconnect and CSP remain covered by the full browser suite.

## Findings and regressions

1. **Nginx's default access/error logs retained request credentials.** Combined
   access logging includes query/Referer; failed upstream diagnostics also include
   the request. A real pinned Nginx container reproduced the leak with an in-memory
   random marker. Its access log now allows only a generated ID, normalized method,
   status/upstream status and timings. Paths, arguments, headers and bodies are
   absent; unknown methods become `OTHER`. Free-form error logging is disabled
   because Nginx cannot redact that context. A successful static request, a forced
   upstream 502 and a valid unknown-method 405 pass the regression. The method
   probe also failed before normalization. This deliberately trades textual proxy
   diagnostics for the bounded access record.
2. **PostgreSQL default constraint diagnostics retained values.** A duplicate
   token-hash marker in a temporary table reproduced row DETAIL/failing SQL in
   database logs. Compose now uses `log_error_verbosity=terse` and
   `log_min_error_statement=panic`; the main constraint diagnostic remains, without
   DETAIL/context/ordinary failing SQL. The real-stack regression was red before
   recreation with this configuration and green afterward. Statement logging is
   `none`, duration threshold `-1`, error parameter logging `0`, verified at runtime.
   These settings and their diagnostic tradeoff follow the
   [PostgreSQL 18 reference](https://www.postgresql.org/docs/18/runtime-config-logging.html).
   The standalone Quality-job PostgreSQL container receives the same flags, so
   its failure-diagnostics step does not restore default DETAIL/statement logging.
   This workflow edit is reviewed locally; its runner execution awaits PR CI.

`security-logs.spec.ts` uses fresh password, pre-auth/session-CSRF and actual
session-token canaries, derived stored token hash and the isolated database
password. It checks public responses, rejection of valid query/auth tokens without
a cookie, safe socket errors, and stdout/stderr of **api, web, db and migrate**.
The database constraint marker is sent through stdin, never a shell-built SQL
command. Assertions report booleans, not matching values; transport errors for
URLs containing the real session token are replaced with a generic error.
`errors.spec.ts` additionally injects an unexpected-error marker and captures
HTTP/socket logger calls, requiring only code and generated request ID.

The CSRF bootstrap JSON and pre-auth/login `Set-Cookie` are intentional credential
channels, with `no-store` and HttpOnly cookies; logout expires its cookie. The
actor's email in auth responses is intentional PII, while message authors expose
ID/name only. These explicit channels are not treated as leaks. The response/log
contract and limitations are in [security boundaries](../security-boundaries.md).

## Fresh verification

Windows/PowerShell, Node 24.21.0, npm 12.1.0; PostgreSQL 18.6 and Nginx 1.30.5.
All commands below belong to this checkpoint; cached Docker build stages are
not counted as fresh test runs. Integration finished before E2E.

| Check | Result | Ignored local evidence in `.git/cp4a-logs/` |
| --- | --- | --- |
| `npm run lint`, `npm run typecheck` | Passed, no warnings/errors | `lint.log`, `typecheck.log` |
| `npm test` | 44 API, 88 Angular, 3 contracts; no skips | `unit-tests.log` |
| `npm run test:docker` | 3 passed, including real proxy regression | `docker-tests.log` |
| `npm run build` | All workspaces passed | `build.log` |
| `npm audit --audit-level=high` | Zero vulnerabilities | `audit.log` |
| Isolated Compose build/start | Healthy API/web/DB, migration exit 0 | `compose-final-build.log` |
| PostgreSQL integration | 21 results passed, including parent, in 12.1 s | `integration.log` |
| Full Chromium E2E | 20 passed in 1.8 min; one worker, zero retries | `e2e.log` |
| Negative controls | Original Nginx access/error log, raw method log and PostgreSQL constraint log fail secret checks before their fixes | `nginx-red.log`, `nginx-method-red.log`, `service-logs-red.log` |
| Runtime PostgreSQL logging settings | Confirmed terse/panic and default disabled statement/parameter logging | `postgres-settings.log` |

One earlier E2E run timed out in Docker `compose up --wait` during persistence
recreation: web remained `Created` with no `State.Error`, while API/DB were
healthy. The remaining tests then failed to connect. Its observed duration was
28.3 minutes despite the existing 150-second process timeout. A prior proxy-test
Docker invocation was also interrupted. Host power events occurred during this
session, but the exact cause of the Docker stall was not established. These
runs are preserved separately (`e2e-infra-interrupted.log`,
`nginx-method-infra-interrupted.log`) and are not green evidence. The isolated
stack was restored with the existing `up --wait`, then the entire E2E suite was
run again; no test timeout, skip or automatic retry was added.

The isolated project is `chat-e2e`, database `cp4a_test`, web 18083, initial host
database port 15491, subnet `172.29.41.0/24`, proxy `.254`; credentials stay in
ignored `.git/cp4a.env`. Persistence E2E recreates from base Compose and removes
the opt-in host DB port while preserving the isolated volume. Root `.env` is
unchanged and `real-time-chat_postgres_data` is preserved. Temporary proxy-test
containers/networks are removed by their fixture. Stack cleanup/review status
must be confirmed separately by the parent; this report does not assign ownership
of a leftover stack. PR CI remains to run after the parent creates a PR.

## Limits and next step

This is a scoped review with executable regressions, not a penetration test or
exhaustive security audit. It covers one API and Chromium over local HTTP;
remote TLS/Secure-cookie deployment, load, other browsers, complete accessibility
and multiple instances remain unverified. Quotas reset with the process, and
already received messages cannot be retracted. Channels remain open to registered
users, so membership is not a confidentiality promise.

Secret scans cover exercised response/error paths and the current four service
logs, not external collectors, host diagnostics, arbitrary operator SQL or every
possible database failure/PANIC. Terse database diagnostics are not a general
redactor. No dependencies, schema, authentication or membership policy changed.
No 4.2a implementation is included. After parent review and manual merge, proceed
to **4.2a — Pulir interacción de escritorio y accesibilidad**; CP0-C and CP1-C
remain pending.
