# ADR-002: Use Socket.IO for live operations and HTTP for persisted reads

## Status

Accepted. Records the transport already implemented; no transport change.

## Date

2026-10-19

## Context

The local chat needs bidirectional sends, acknowledgements, channel subscriptions
and automatic reconnection. Persisted history must remain readable independently
of live event delivery. One Angular client and one NestJS API share one origin.

## Decision

Use Socket.IO at `/socket.io`, with Engine.IO polling followed by WebSocket
upgrade when available. This is the Socket.IO protocol, not a raw WebSocket API;
a generic WebSocket client cannot use the application event contract directly.
Use acknowledged `message:send`, `channel:subscribe` and `channel:unsubscribe`
operations, and server `message:created` events. Identity, discovery, membership,
history and bounded recovery use HTTP under `/api`.

Nginx serves Angular and proxies both paths to the API. The existing session
cookie authenticates the socket; exact-origin checks cover polling and upgrades.
The gateway revalidates the session for operations, and membership authorizes
subscription/send. A subscribed room is delivery state, not an authorization
credential. Subscription is not required to send; membership is.

## Alternatives considered

- Raw WebSocket would need application framing, acknowledgements, reconnect and
  room coordination implemented here. It avoids the Socket.IO protocol dependency
  but adds code without a requirement for a generic WebSocket client.
- SSE plus HTTP sends fits server-to-client streaming, but splits the live
  operation/ack model; the current bidirectional protocol already meets scope.
- Polling only avoids upgrades, at the cost of repeated reads and delayed live
  updates. HTTP reads remain the authoritative recovery path in this design.

## Consequences

The client depends on Socket.IO and the proxy must support both polling and
upgrade. Reconnect restores a transport, then the app resubscribes and reconciles
the visible channel; it does not prove all events arrived. There is one API
process with the synchronous in-memory adapter. Rooms, queues, revocation events
and quotas are process-local; adding replicas needs a separate design.

No durable event log or outbox is included. Commit can succeed before emission or
ack fails. [Message guarantees](004-message-guarantees.md) and
[bounded recovery](001-bounded-message-recovery.md) define repair and limits.

## Evidence

- [Gateway](../../apps/api/src/realtime/chat.gateway.ts), [client](../../apps/web/src/app/core/realtime-connection.ts) and [Nginx routes](../../docker/nginx.conf).
- [Handshake/reconnect browser test](../../e2e/handshake.spec.ts) checks the real upgrade and restored connection.
- [Subscription integration](../../apps/api/test/integration/subscriptions.ts) checks authorization and leave/send/subscription races.
- [Session integration](../../apps/api/test/integration/socket-session.ts) checks revocation/expiry and reconnect rejection.
