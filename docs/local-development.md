# Local identity and Socket.IO

Use Node/npm versions pinned in the repository for host commands, or Docker
Compose for the compiled application. No remote deployment is required.

## Run at localhost:8080

Copy `.env.example` to `.env` and set a private `POSTGRES_PASSWORD`.
Set `APP_ORIGIN=http://localhost:8080` and `WEB_PORT=8080`, then run:

```text
docker compose up --build --wait
```

Open `http://localhost:8080/register`, create an account and sign in. The workspace
should show **Live connection established.** DevTools Network should show the
`/socket.io/` polling requests and a WebSocket upgrade (101). The initial page and
HTTP API use the same origin; there is no separate socket port or browser token.
The cookie is HttpOnly/SameSite=Lax; HTTPS configuration adds Secure and the
`__Host-` prefix. Do not mix `localhost` and `127.0.0.1`: origins and cookies differ.

Nginx forwards polling and WebSocket upgrades, preserves Origin/Referer and uses
a 75-second read timeout, above Socket.IO's default heartbeat window. Engine
middleware checks the exact configured origin on requests and upgrades; a
same-origin Referer is accepted for requests without Origin (browser polling).
Each Socket.IO namespace connection validates the session in PostgreSQL, including
reconnections. Auth payloads and query tokens cannot replace the session cookie.

For container source reload use `docker compose -f compose.yaml -f compose.dev.yaml
up --build --watch`. Both Angular proxy configurations forward `/socket.io/` with
WebSocket support. Host Angular uses `proxy.conf.json` and needs
`APP_ORIGIN=http://127.0.0.1:4200` on the API; container Angular uses
`proxy.docker.json` and the same configured public origin as Nginx.

## Verify restart in an isolated stack

Copy `.env.example` to `.env.e2e`, use a new private database password and set
`WEB_PORT=18083`, `APP_ORIGIN=http://localhost:18083`. Run:

```text
docker compose -p chat-e2e --env-file .env.e2e up --build --wait
npx playwright install chromium
```

Set these variables in the shell before `npm run test:e2e`:

| Variable | Value |
| --- | --- |
| `E2E_BASE_URL` | `http://localhost:18083` |
| `E2E_COMPOSE_PROJECT` | `chat-e2e` |

The suite creates synthetic accounts. The handshake test checks the container's
Compose project label, stops only `chat-e2e-api-1`, observes reconnecting feedback,
starts it again in a finally block and checks reconnection with the original
cookie. It accepts only the named disposable projects `chat-e2e`, `ci-chat` and
`handshake-verification`; it must not target the development stack. No volume is
deleted by the test. Run it without competing tests or manual use of that stack.

Stop the isolated stack with `docker compose -p chat-e2e --env-file .env.e2e down`.
Its dedicated volume retains test data; the normal development volume is separate.

## Diagnose a rejected or interrupted connection

- **401 / authentication required:** sign in again; missing, malformed, expired
  and revoked cookies cannot authenticate a new socket.
- **400 on `/socket.io/`:** check `APP_ORIGIN`, browser hostname and forwarded
  Origin/Referer. A foreign origin is deliberately rejected for both transports.
- **502 / reconnecting:** check `docker compose ps` and `docker compose logs api
  web`. After the API returns, the client reconnects automatically with backoff.
- **Polling works but no upgrade:** check Upgrade/Connection forwarding and the
  `/socket.io/` proxy route. Socket.IO can remain on polling if upgrade is unavailable.
- **Namespace rejection after a transient database error:** retry the connection
  using the workspace button. No internal exception details are shown.

No chat events, channels or message replay are implemented here. Authentication
at connection time does not authorize future operations. Server-side closure of
already-open sockets on expiry/revocation remains in 3.4a; local logout or leaving
the workspace closes this browser's socket now. Connection-state recovery is not
enabled, and cross-instance coordination is not part of this single-instance task.

Implementation references: [Nest gateways](https://docs.nestjs.com/websockets/gateways),
[Socket.IO middleware](https://socket.io/docs/v4/middlewares/),
[reverse proxy](https://socket.io/docs/v4/reverse-proxy/) and
[client lifecycle](https://socket.io/docs/v4/client-socket-instance/).
