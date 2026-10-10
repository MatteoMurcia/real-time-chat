# Local identity and Socket.IO

Use Node/npm versions pinned in the repository for host commands, or Docker
Compose for the compiled application. No remote deployment is required.

The compiled stack needs only Git and Docker Compose on the host. Node, npm,
Prisma, PostgreSQL and Nginx run in images; host Node/Playwright is needed only
for the automated browser tests below. Base Compose has no bind mounts: the
database uses a named volume, and application files are copied during build.

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
| `E2E_COMPOSE_ENV_FILE` | `.env.e2e` |

The suite creates synthetic accounts. The handshake test checks the container's
Compose project label, stops only `chat-e2e-api-1`, observes reconnecting feedback,
starts it again in a finally block and checks reconnection with the original
cookie. It accepts only the named disposable projects `chat-e2e`, `ci-chat` and
`handshake-verification`; it must not target the development stack. No volume is
deleted by the test. Run it without competing tests or manual use of that stack.

The persistence test also removes and recreates **all containers in that project**
using base `compose.yaml` and the explicit environment file. It checks that there
are no bind mounts, PostgreSQL uses the expected named volume, container IDs
change, migrations finish successfully, the existing browser session survives,
and signing out and back in works. It never passes `--volumes` to `down`.

Stop the isolated stack with `docker compose -p chat-e2e --env-file .env.e2e down`.
Its dedicated volume retains test data; the normal development volume is separate.

## Stop, recreate and verify persistence manually

Keep the same Compose project name, environment file and database credentials:

```text
docker compose -f compose.yaml down
docker compose -f compose.yaml up --no-build --wait
```

Refresh the workspace: an unexpired session should still work. Sign out and sign
in with the same account to confirm user/password persistence. Migration runs
again and should exit with code 0 without reapplying completed migrations.
`stop`/`start` retains containers; `down`/`up` recreates them while retaining named
volumes. Changing the project name selects a different volume. Changing
`POSTGRES_PASSWORD` does not update credentials inside an existing database.
Never use `down --volumes` for the working database to troubleshoot a login.

For a clean build, run `docker compose -f compose.yaml build --no-cache`, then
the `up --no-build --wait` command. Build requires registry/package downloads;
starting existing images does not need Node/npm on the host.

To check a second empty database without deleting existing data, copy the test
environment to `.env.fresh`, choose another unused web port (for example 18084)
and matching `APP_ORIGIN=http://localhost:18084`, then use a new project name:

```text
docker compose -p chat-fresh --env-file .env.fresh -f compose.yaml up --build --wait
docker compose -p chat-fresh --env-file .env.fresh -f compose.yaml ps -a
docker compose -p chat-fresh --env-file .env.fresh -f compose.yaml logs migrate
```

Confirm that the project/volume did not already exist. The old account must not
sign in here; registering and signing in with a new account should work. Stop it
with the same project/environment arguments and `down`. For disposable test data
only, verify the volume's `com.docker.compose.project` label before removing it.

Docker references: [Compose down](https://docs.docker.com/reference/cli/docker/compose/down/)
and [named volumes](https://docs.docker.com/reference/compose-file/volumes/).

## Diagnose a rejected or interrupted connection

Start with `docker compose -f compose.yaml ps -a` and
`docker compose -f compose.yaml logs --tail 100 db migrate api web` (use the same
project/environment arguments for an isolated stack). `migrate` exiting 0 is
normal. A failed migration blocks initial API/web startup; correct the reported
cause, then recreate the stack without deleting the volume. If the web port is
occupied, choose another `WEB_PORT` and matching `APP_ORIGIN`. Do not publish raw
environment/config output containing database credentials.

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
