# Local security boundaries

The supported demo runs one API behind Nginx on loopback HTTP. Channels are open
to registered users: anyone can join and read earlier messages. Membership gates
operations and future server delivery; it cannot retract data already received.

## Identity, origin and membership

The session cookie determines the actor. A client-supplied `authorId`, `userId`,
Socket.IO auth field or query parameter cannot impersonate another account.
Message requests reject extra fields; canonical acknowledgements, events and
stored rows use the authenticated author. HTTP mutations require a CSRF token
bound to the current session (pre-auth cookie/token pairing for registration and
login). An exact `APP_ORIGIN` check, with same-origin Referer fallback when Origin
is absent, protects mutations and every Engine.IO request, including upgrades.

History, recovery, subscription and send require live session and channel access.
Cursors are canonical positions bound to a channel, not signed authorization
capabilities. Knowing or constructing a valid cursor does not grant membership.
Logout, expiry and leaving remove access; the existing delivery filter excludes
revoked/expired sessions even if active socket closure is delayed.

| Boundary | Reproducible evidence |
| --- | --- |
| Pre-auth origin, cookie/token pairing, forgery and expiry | `apps/api/test/registration.spec.ts`; registration/login integration in `database.spec.ts` |
| Session-bound CSRF, cross-session token rejection, logout and expiry | `apps/api/test/logout.spec.ts`; logout integration in `database.spec.ts` |
| Empty, opaque, lookalike and foreign origin on register/login/logout/create/join/leave; rejected mutations have no effect | `apps/api/test/integration/database.spec.ts`, `channels.ts`, `membership.ts` |
| Origin on polling, WebSocket and a subsequent polling request; an auth payload cannot replace a cookie | Socket.IO integration in `database.spec.ts` |
| Claimed handshake/query identity and `authorId` cannot override the authenticated author in storage/events | `apps/api/test/integration/messages.ts`; direct clients in `e2e/subscriptions.spec.ts` |
| Missing membership, cross-channel/malformed/borrowed/constructed cursor and revoked access | `apps/api/test/integration/history.ts`, `message-sync.ts`, `subscriptions.ts`; `e2e/subscriptions.spec.ts` |
| Future emission after leave/revocation/expiry, including delayed closure and subscribe/leave races | `apps/api/test/integration/messages.ts`, `subscriptions.ts`, `socket-session.ts`; existing session/subscription E2E |
| Executable-looking HTML remains literal text in live delivery and persisted history in two browsers | `e2e/conversation.spec.ts`: `img`, `svg` and `script` nodes absent; execution marker absent; canonical ID preserved after reload |
| Browser response headers, Angular startup and real socket reconnect without CSP violations | `e2e/security-headers.spec.ts`, `e2e/conversation.spec.ts` |

These extend existing fixtures rather than duplicating security-specific runners.
Run `npm run test:integration --workspace @real-time-chat/api` with a separate
`TEST_DATABASE_URL` ending in `_test`, then run `npm run test:e2e` against the
isolated Compose stack as described in [local development](local-development.md).
Integration and E2E must not share that database concurrently. Existing rate-limit
integration uses the real defaults in a separate application; only high-volume
recovery fixtures raise the four attempt thresholds to 1000.

## Browser response headers

Nginx applies these headers to documents, assets, proxied API responses/errors
and Engine.IO polling responses, using `always`:

```text
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: same-origin
Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'
```

Angular inserts component styles at runtime, so inline styles remain allowed.
Critical CSS inlining is disabled because the current build also generates an
inline script to activate the stylesheet; scripts stay restricted to same-origin
files. Other build optimizations keep their schema defaults. HTML interpolation
still provides the primary content boundary: tests assert the DOM, so CSP cannot
hide an HTML-rendering regression. `expires -1` retains document/asset revalidation
without a location-level `add_header` overriding the server headers.

HSTS is deliberately absent on this loopback HTTP demo. These headers are provided
by Nginx; the internal API is not a separately exposed browser entry point. HTTPS,
Secure cookies, proxy/origin configuration and a deployment-specific CSP need
review before remote use. CSP here permits Angular's inline styles and does not
claim a nonce-based strict policy.

## Limits

The entry-point and response/log review is recorded in [CP4-A](checkpoints/cp4-a.md).
CP0-C and CP1-C remain pending. The tests cover one API instance and Chromium, without a load,
multi-browser or comprehensive accessibility/security audit. Traffic quotas and
their process-local limitations are documented in [traffic limits](traffic-limits.md).

## Credentials, responses and logs

Passwords, password hashes, raw session tokens and stored token hashes are not
public fields. Registration/login/me expose the actor's intended user projection
(including their email); messages expose author ID/display name only. The
pre-auth and session-CSRF bootstrap JSON deliberately contains a CSRF token.
Pre-auth/login `Set-Cookie` deliberately carries the HttpOnly cookie, and logout
expires the session cookie. These explicit credential channels use `no-store`;
they are excluded from secret-echo checks. Query/auth payload credentials never
replace the session cookie, even when the token is valid.

Nginx access logs contain only its generated request ID, an allowlisted HTTP
method (`OTHER` for unknown methods), status/upstream status and request/upstream
duration. They omit paths, query parameters, headers (including Referer,
Authorization and cookies) and bodies. Nginx's free-form error log is disabled
because upstream failures include unredacted request context; access statuses
and timings remain available. This intentionally sacrifices textual proxy
diagnostics. The proxy's generated request ID is independent of the API's ID.

Compose starts PostgreSQL with `log_error_verbosity=terse` and
`log_min_error_statement=panic`: ordinary constraint failures retain their main
diagnostic but omit row DETAIL, context and failing SQL. Parameter logging stays
at its default zero on error, with ordinary statement/duration logging disabled.
This reduces database debugging detail; it is not a general-purpose scrubber for
arbitrary SQL or database PANIC failures. See the [PostgreSQL logging reference](https://www.postgresql.org/docs/18/runtime-config-logging.html).
HTTP/socket error adapters log only a server-generated request ID and error code,
and expose generic errors. Prisma query/error logging is not enabled.

`docker/nginx-logs.test.mjs` runs the pinned real proxy with successful, unknown
method and failed upstream requests. `e2e/security-logs.spec.ts` scans stdout and
stderr for all four services using fresh password/session/CSRF canaries and a
temporary database constraint error; boolean assertions never print values.
`apps/api/test/errors.spec.ts` captures HTTP/socket unexpected-error logging and
requires the exact code/request-ID projection. These checks cover exercised
paths in the compiled local demo; they do not audit external log collectors,
host diagnostics, operator SQL or all possible database failures.
