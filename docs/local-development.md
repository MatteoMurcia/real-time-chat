# Local identity and Socket.IO

Use Node/npm versions pinned in the repository for host commands, or Docker
Compose for the compiled application. No remote deployment is required.

The compiled stack needs only Git and Docker Compose on the host. Node, npm,
Prisma, PostgreSQL and Nginx run in images; host Node/Playwright is needed only
for the automated browser tests below. Base Compose has no bind mounts: the
database uses a named volume, and application files are copied during build.

The [final local delivery smoke](delivery-verification.md) records a clean GitHub
clone, two-user permissions and recovery after API restart, then full container
recreation with retained sessions and saved messages. See
[future deployment requirements](deployment-readiness.md) for the work needed
before any remote exposure; the current supported installation remains local.

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
The development override disables API proxy trust because Angular can forward
client-supplied headers. Development login/registration quotas group by peer;
base Nginx instead overwrites forwarded headers and uses an explicitly trusted
static IP. See [traffic limits and proxy configuration](traffic-limits.md).

## Verify restart in an isolated stack

Copy `.env.example` to `.env.e2e`, use a new private database password and set
`WEB_PORT=18083`, `APP_ORIGIN=http://localhost:18083`,
`BACKEND_SUBNET=172.29.41.0/24` and `PROXY_IP=172.29.41.254`. For the full E2E
suite set `SEND_LIMIT`, `LOGIN_LIMIT`, `REGISTER_LIMIT` and `CHANNEL_CREATE_LIMIT`
to 1000 in this disposable environment only. Recovery fixtures send over 100
messages; default quotas are tested separately by API integration. Run:

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
and matching `APP_ORIGIN=http://localhost:18084`. Also choose a different
`BACKEND_SUBNET=172.29.42.0/24` and `PROXY_IP=172.29.42.254`, then use a new project name:

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

Authentication at connection time does not authorize future operations. Channels,
messages and bounded HTTP recovery have their own permission checks. Socket.IO
connection-state recovery is not enabled; coordination supports one API instance.

## Session lifecycle

The server indexes sockets by session and uses one absolute-expiry timer per
connected session. Logout emits revocation only after the database deletion,
then closes every socket of that session. Other sessions of the same user remain
connected. Idle sockets also expire without sending another command. The last
disconnect clears its timer; module shutdown clears all timers and the local
revocation subscription.

Registration indexes the socket before a second database authentication: logout
before indexing is caught by the read, and logout afterwards by the notification.
A stale authentication result cannot reopen a disconnected socket. A database
failure closes the transport without claiming that the session was revoked.

Before closing an ended session, the server emits `session:ended` without a
payload. The browser clears identity, conversation and drafts and returns to
login. An authenticated handshake rejection after reconnect does the same.
The tab performing logout waits for its HTTP response to clear the HttpOnly
cookie before navigation; a received ended notification confirms revocation even
if that response fails. If both signals are lost, the existing error/retry path
remains available. Transient connection failures retain identity for retry.

Session timers and revocation notifications are process-local; distribute both
before adding API instances. A blocked event loop can delay closure, so commands
and message delivery still validate sessions independently. Already transmitted
events and accepted in-flight operations cannot be retracted by closing a socket.

Implementation references: [Nest gateways](https://docs.nestjs.com/websockets/gateways),
[Socket.IO middleware](https://socket.io/docs/v4/middlewares/),
[reverse proxy](https://socket.io/docs/v4/reverse-proxy/) and
[client lifecycle](https://socket.io/docs/v4/client-socket-instance/).

## Reproducible integration in containers

Use the standalone test file, rather than combining it with `compose.yaml`.
Only Git and Docker Compose are needed. Choose a unique private test password;
in PowerShell 7+ it can be generated without installing Node or OpenSSL:

```powershell
$env:TEST_POSTGRES_PASSWORD = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
```

On a shell with OpenSSL, use `export TEST_POSTGRES_PASSWORD="$(openssl rand -hex 24)"`.
Do not echo, commit or reuse the password. The test settings do not consume the
development `POSTGRES_PASSWORD` or `DATABASE_URL`.

```text
docker compose -p real-time-chat-integration -f compose.test.yaml run --build --rm integration
docker compose -p real-time-chat-integration -f compose.test.yaml run --rm -e INTEGRATION_ORDER=reverse integration
docker compose -p real-time-chat-integration -f compose.test.yaml down --volumes --remove-orphans
```

Run cleanup even when either test command fails. PowerShell users can place test
commands inside `try { ... } finally { <cleanup command> }`; shell users can use
an EXIT trap. Preserve/check each test command's exit code; cleanup success does
not mean tests passed. `npm run test:integration` is an optional shortcut for the
first command when host Node/npm is available; it does not perform cleanup.

The explicit project name prevents a development `COMPOSE_PROJECT_NAME` from
selecting the primary stack. For simultaneous independent runs, use a distinct
test project name consistently for all commands. Never use the primary project's
name for test cleanup. This stack has no published ports, host bind mounts or
named volumes: PostgreSQL uses tmpfs, and tools are compiled into the test image.
The runner is non-root; migration engines are downloaded during build before
joining the internal network. No demo seed is executed.

Each of the 19 scenarios creates a private `suite_<uuid>_test` database, applies
all committed migrations, verifies the five data tables start empty and starts
an independent app. Constraint fixtures create their own user/session instead
of relying on an earlier scenario. Generated databases are dropped after the
scenario, even on assertion failure. The test role needs CREATEDB only in this
disposable server. No supplied database name is used as a deletion target.

The quota fixture temporarily mocks the process clock, so scenarios run serially
within each Node process. CI repeats the same image in reverse order without
restarting PostgreSQL and checks after each pass, including failures, that no
generated databases remain and the base has no public tables. Neither
suite order nor demo data is a prerequisite. Existing per-scenario deadlines and
all behavior assertions remain in place.

The new **Integration** job uses a unique project and masked random password for
every run. It propagates the runner's exit status, reports service status and
bounded database logs on failure, and always removes its own stack. PostgreSQL
logging omits failing SQL/constraint detail; migration setup errors expose a safe
phase rather than captured connection output. Do not publish environment files,
expanded Compose configuration or full container inspection output as diagnostics.

References: [Compose one-off test containers](https://docs.docker.com/reference/cli/docker/compose/run/)
and [health-dependent startup](https://docs.docker.com/compose/how-tos/startup-order/).

### Verification evidence — 4.3a (2026-10-19)

[CI 39171553695](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39171553695)
on `178ccde` included a temporary assertion failure after the duplicate-key
scenario's real checks. **Integration failed with exit code 1 and the exact
controlled-probe assertion**. The subsequent cleanup query still passed: no
generated suite database or base public table remained. Safe diagnostics and
stack teardown passed. Quality and Containers passed, including all 22 E2Es.
The two failed Node results were the intended scenario and its parent; the
remaining 19 passed. Reverse-order steps correctly did not run after that failure.

Commit `1ab8a0c` removed the probe, restoring the full scenario assertions.
[CI 39171836883](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39171836883)
then passed **21/21 integration results in each order**, approximately 28 seconds
per pass, with zero failures, cancellations or skipped tests. Both cleanup queries
and stack removal passed while the same PostgreSQL instance served both passes.
These are two executions of the same scenarios, not 42 distinct tests.
The same run passed all three jobs: **45 API, 103 Angular, 3 contracts, 5 Docker
checks and 22 Chromium E2Es**, with zero audit vulnerabilities.

Host verification passed **45 API tests**, four URL-preload tests, lint/typecheck
and Compose configuration validation. Docker Desktop's Linux engine is unavailable
locally: the existing real-Nginx Docker test fails on missing Docker, so neither
container execution nor that check is claimed as a local success. CI supplies the
real Docker/PostgreSQL/browser evidence. No test was suppressed to accommodate
the local limitation.

The independent reviewer and parent checked isolation, retained assertions,
cleanup and final probe removal. Review suggestions added cleanup checks after
both passes on the same server and clarified the PowerShell version. Primary
environment/data are preserved; no production role, API, schema, dependency or
deployment changes are included. [CP4-B](checkpoints/cp4-b.md) subsequently verifies
the merged integration alongside desktop/mobile usability. CP0-C and CP1-C remain pending.
