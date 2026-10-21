# Traffic and input limits

The single API process applies these sliding windows. An attempt at time T leaves
its window exactly at T + duration. Attempts rejected because a quota is full do
not add timestamps.

| Operation | Default | Identity | Environment variable |
| --- | --- | --- | --- |
| `message:send` | 30 attempts / 10 seconds | User, across every socket and session | `SEND_LIMIT` |
| `typing:update` | 10 attempts / 10 seconds | User, across every socket and session | `TYPING_LIMIT` |
| `presence:get` | 20 attempts / 10 seconds | User, across every socket and session | `PRESENCE_LIMIT` |
| `POST /auth/login` | 10 attempts / minute | Client IP | `LOGIN_LIMIT` |
| `POST /auth/register` | 5 attempts / hour | Client IP | `REGISTER_LIMIT` |
| `POST /channels` | 10 attempts / hour | Authenticated user, across sessions | `CHANNEL_CREATE_LIMIT` |
| Socket.IO namespace connection | 5 simultaneous connections | Session | `SESSION_CONNECTION_LIMIT` |

Threshold overrides accept integers 1–1000; durations stay fixed. Defaults apply
without adding variables to an existing `.env`. People sharing an IP also share
its login/registration budget. Direct service calls used by fixtures are internal
operations; public HTTP/socket adapters enforce the quotas.

Message attempts consume budget using the server's handshake identity before
payload validation, channel queueing or another database authentication read.
Typing follows the same ordering with its own budget; start, stop and invalid
attempts all count. Typing is optional and the browser does not await or retry
its ack. Rejected/dropped updates disappear through the [five-second TTL](typing.md).
Presence queries use the same ordering with their own budget and at most 100
unique target IDs. Invalid requests count too; safe errors never imply offline.
The [presence contract](presence.md) requires live sessions and shared membership.
Malformed messages, conflicts and idempotent retries consume budget too. Live
session/membership authorization still runs for accepted operations. Login and
registration count before CSRF, input validation and password hashing; channel
creation counts after session authentication and before CSRF/input validation.
Malformed JSON and bodies over the HTTP parser's 8 KiB limit are rejected before
the controllers, so they do not consume controller quotas or reach persistence.

HTTP quota rejection is `429` with the common safe `RATE_LIMITED` error. Socket
events return `{ ok: false, error }` with the same code. A sixth session connection
receives `connect_error` with a safe `data` error, retaining the user's session.
Close another tab and use **Retry connection**. Namespace slots are reserved
synchronously before acceptance and released on disconnect or transport closure,
including a handshake aborted before namespace connection. No explicit quota
error triggers an automatic message retry. A rate-limited send remains unconfirmed
and retains its original key for manual retry: an earlier attempt may already
have committed while its acknowledgement was lost.

The existing input bounds remain: socket payloads at most 16 KiB, message text
1–2000 Unicode code points with nonblank content, and channel/history/sync pages
at most 100 (default 50). Oversized transport payloads close the connection before
message processing; invalid message objects receive `VALIDATION_ERROR`. Invalid
JSON receives HTTP 400; oversized HTTP bodies receive 413. Rejected messages do
not change saved messages or channel sequence counters.

## Proxy identity

Host API startup trusts no forwarded IP by default. `TRUSTED_PROXY_IPS` accepts
only a comma-separated list of exact peer IP addresses, never `true`, hop counts
or whole private networks. IPv4-mapped peer addresses are normalized. Express
uses `X-Forwarded-For` only through explicitly trusted peers and stops at the
first untrusted address. The configured `APP_ORIGIN` remains independent of
forwarded headers.

Base Compose assigns the web proxy `PROXY_IP=172.29.0.254` within
`BACKEND_SUBNET=172.29.0.0/24` and trusts that exact peer. Nginx replaces incoming
forwarded IP/host/protocol headers with its observed values for HTTP and sockets.
If the subnet overlaps another local/Docker network, change both variables
together; Docker rejects a static IP outside its subnet. Each concurrently
running Compose project needs a different subnet and matching proxy address.

The Angular development proxy forwards existing headers. `compose.dev.yaml`
therefore explicitly clears API proxy trust; host development also leaves
`TRUSTED_PROXY_IPS` empty. Development IP quotas aggregate by the proxy peer and
client-supplied forwarded headers cannot split its budget. Do not enable proxy
trust there without configuring the development proxy to overwrite headers.

This follows [Express proxy trust](https://expressjs.com/en/guide/behind-proxies/)
and [Socket.IO middleware lifecycle](https://socket.io/docs/v4/middlewares/).

## Memory, restarts and tests

Quota state is process-local and resets on API restart. Each quota key retains
only its configured number of timestamps; at most 10,000 action/identity keys
are retained. Expired keys are swept every minute and when capacity is reached.
A full map rejects new identities with `RATE_LIMITED` rather than evicting active
budgets. Connection accounting also caps tracked sessions at 10,000. Cleanup
timers do not keep the process alive and are cleared on application shutdown.
Replace this store with shared accounting before running multiple API instances.
These are the section 6.7 operation quotas, not general denial-of-service
protection: other reads, subscriptions and unauthenticated transport handshakes do not
have additional quotas in this task.

Unit tests use a controlled clock for exact sliding boundaries, cleanup and slot
release. The integration suite starts a separate app with the real defaults and
checks HTTP errors, untrusted/trusted proxy peers, concurrent session handshakes,
an aborted reserved slot, shared user budgets, retries, an over-quota ack while
accepted channel work is held, and oversized polling/WebSocket payloads against
PostgreSQL without rejected writes.

Recovery fixtures intentionally send 105 messages and create many accounts from
one IP. Their integration app and the isolated E2E stack explicitly set
`SEND_LIMIT`, `LOGIN_LIMIT`, `REGISTER_LIMIT` and `CHANNEL_CREATE_LIMIT` to 1000.
CI uses the same explicit E2E configuration. The default integration app is never
relaxed; the session connection limit remains 5 in both suites. Run integration
before E2E when they use the same disposable database.
