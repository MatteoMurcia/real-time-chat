# ADR-003: Keep opaque sessions in PostgreSQL and authenticate by cookie

## Status

Accepted. Records the implemented identity/session boundary.

## Date

2026-10-19

## Context

The browser uses same-origin HTTP and Socket.IO. Logout and absolute expiry must
affect active sockets, while API restart must preserve valid sessions. The local
application does not need cross-service bearer tokens or a third-party identity
provider.

## Decision

Hash passwords with Argon2id. Each login generates a random 32-byte opaque token;
store only its SHA-256 digest with the user and absolute expiry in PostgreSQL.
Deliver the raw token only in an HttpOnly, SameSite=Lax, Path=/ cookie. Loopback
HTTP uses `chat_session`; HTTPS uses Secure and `__Host-chat_session`, selected
from configured `APP_ORIGIN`. Never infer that policy from forwarded headers.

Use exact-origin checks plus separate pre-auth and session-bound CSRF tokens for
state-changing identity operations. Browser storage and URLs contain no session
token. The UI's memory/session timer helps navigation; server authentication
remains authoritative. Login creates a session; registration does not.

Logout deletes the current session before confirming success, then its local
revocation event closes that session's sockets. Other sessions survive. Absolute
expiry is checked on authentication and closes idle sockets by timer; recipients
are checked again before live delivery. Failed database work must not confirm
revocation. API restart loses process-local CSRF keys, so clients fetch fresh
CSRF tokens; stored valid sessions remain usable.

## Alternatives considered

- JWT bearer tokens reduce session lookups but still need a revocation strategy
  for immediate logout/active-socket closure. That trade-off does not benefit this
  single-service browser app.
- An in-memory session store is small but loses identities on restart. PostgreSQL
  is already required and provides the persistence/revocation boundary.
- An external identity provider adds configuration/services outside the local
  delivery scope. Password recovery, email verification and MFA are not included.

## Consequences

Authentication depends on PostgreSQL availability. Expired rows are rejected but
not automatically pruned. CSRF keys, socket timers and revocation notifications
are process-local; this is not a distributed identity system. Loopback HTTP is
an explicit local allowance, not a remote deployment policy. HTTPS, restricted
database credentials and shared process state need review before remote use.

## Evidence

- [Session service](../../apps/api/src/identity/session.service.ts), [CSRF service](../../apps/api/src/identity/csrf.service.ts), [socket lifecycle](../../apps/api/src/realtime/connections.service.ts).
- [Real database/HTTP identity integration](../../apps/api/test/integration/database.spec.ts) covers login, cookie policy, CSRF and revocation.
- [Socket-session integration](../../apps/api/test/integration/socket-session.ts) covers idle expiry, revoked sockets and race windows.
- [Browser sessions](../../e2e/session.spec.ts), [revocation](../../e2e/session-revocation.spec.ts) and [restart persistence](../../e2e/persistence.spec.ts).
