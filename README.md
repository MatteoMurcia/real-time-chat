# Real-time Chat

[GitHub repository](https://github.com/MatteoMurcia/real-time-chat)

A fullstack portfolio project focused on reliable team messaging: persistent
conversations, explicit channel permissions, idempotent sends, and recovery after
connection failures.

## Project status

The Angular web scaffold and NestJS API run locally. The initial page checks API
liveness and displays loading, failure, and recovery states. Environment
validation, HTTP/component tests, and strict TypeScript checks are available.
The web, API, PostgreSQL and migration job run locally through Docker Compose.
Prisma manages the User/Session schema and the API database connection lifecycle.
Container development supports automatic source reload. Account registration is
available at `/register`, with validation, safe errors and submission feedback.
Success redirects to `/login` with confirmation; login/sessions and chat remain pending.

The implementation checklist is maintained in [tasks/plan.md](tasks/plan.md).
Product choices and scope are documented in
[docs/ideas/real-time-chat.md](docs/ideas/real-time-chat.md).
Planning documents are in Spanish; public project documentation is in English.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch and commit conventions,
pull request process, and verification requirements.

## Planned scope

- Registration, login, logout, and server-side sessions.
- Open team channels with explicit membership and authorization.
- Persistent text messages and cursor-based history pagination.
- Send confirmations, retries without duplicate messages, and reconnection recovery.
- Responsive, accessible UI and tests for failure scenarios.

Read receipts, typing indicators, and presence are planned follow-up features.
Private conversations, attachments, video calls, and multiple organizations are
outside the initial scope.

## Planned stack

| Layer | Technology |
| --- | --- |
| Frontend | Angular and TypeScript |
| Backend | Node.js, NestJS, and Socket.IO |
| Database | PostgreSQL and Prisma |
| Local runtime | Docker Compose |
| Verification | Unit and integration tests, Playwright E2E, GitHub Actions |

## Run everything with Docker

Only Git and Docker with Compose are required on the host. Use Linux containers
in Docker Desktop on Windows/macOS. Copy `.env.example` to `.env` if it does not
exist, fill `POSTGRES_PASSWORD` with a private password, and keep the example
database/user names (or choose your own). See the password generation examples
below. Preserve the credentials for an existing database volume.

```text
docker compose config --quiet
docker compose up --build --wait
```

Open <http://127.0.0.1:8080>. The Angular page should show **API is reachable**.
Change `WEB_PORT` in `.env` if port 8080 is occupied. Only this web port is
published, on loopback. API and database communicate through an internal network.
The containers build their database URL from `POSTGRES_*`, escaping credentials;
host `DATABASE_URL`, `NODE_ENV`, `HOST` and `PORT` values do not configure them.
You may leave `DATABASE_URL` and `TEST_DATABASE_URL` blank for this Docker flow.

Startup order is database healthy → migration exits successfully → API healthy
→ web healthy. `migrate` showing **Exited (0)** is expected. If it fails, API/web
do not start; inspect `docker compose logs migrate` and fix the cause before
retrying. An already running API must be stopped before applying a new migration:
run `docker compose down` followed by the startup command for an updated build.
This preserves the database volume and ensures the startup gate applies.

```text
docker compose ps -a
docker compose logs --tail 50 migrate api web
docker compose down
```

Use `down` without `--volumes` to retain data. Images use pinned Node 24.21.0,
npm 12.1.0, Nginx 1.30.5 and PostgreSQL 18.6 versions. API/web builds run their
tests inside Linux; final API/web processes run as non-root users. Migration
tools are in a separate image target. Use the development override below for
automatic source reload.

`npm run test:docker` checks container URL construction (including reserved
characters in credentials) without starting Docker. The images exclude local
environment files, generated output, dependencies and private key files from
their build context.

## Develop inside Docker

Use Docker Compose 2.32+ (verified with 5.5.1). The following commands work in
PowerShell and Unix shells from the repository root, after configuring `.env`
as above. Stop an existing stack before switching modes; data is retained.
If this origin was opened with an older image, hard-refresh the browser once
(Ctrl+Shift+R on Windows/Linux, Cmd+Shift+R on macOS) to discard previously cached
bundles. The base server requires revalidation of its unversioned assets.

```text
docker compose down
docker compose -f compose.yaml -f compose.dev.yaml up --build --watch
```

Open <http://127.0.0.1:8080>. Keep this terminal running.
[Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/) synchronizes
`apps/web/src` for Angular's live reload and `apps/api/src` for automatic API
recompilation/restart. API requests can briefly fail during that restart; use
**Check again** when it is ready. Source edits do not rebuild images.

There are no host dependency mounts: Linux `node_modules` stays in each image,
and the generated Prisma client is excluded from synchronization. Both app
containers run as non-root. Only the web port is published, on loopback; the
development proxy reaches the API through its internal service name.

Changes outside these source directories (dependencies, lockfile, configuration,
Dockerfiles, `packages/contracts`, or Prisma schema/migrations) require stopping Watch with Ctrl+C,
then running the following commands. This also applies migrations before API
startup and regenerates the client; Watch never resets or migrates your database.

```text
docker compose -f compose.yaml -f compose.dev.yaml down
docker compose -f compose.yaml -f compose.dev.yaml up --build --watch
```

To verify reload, temporarily edit a heading in `apps/web/src/app/app.html` and
the response in `apps/api/src/health/live.controller.ts`. Check the page and
`/api/health/live`, then restore both edits and confirm recovery. To compare
against the normal build, stop Watch, run the development `down` command, then
`docker compose up --build --wait`. Never use `down --volumes` for switching modes.

## Optional host development toolchain

| Tool | Pinned version |
| --- | --- |
| Node.js | 24.21.0 |
| npm | 12.1.0 |
| TypeScript | 6.0.3 |

Node is pinned in `.node-version`; `package.json` declares the exact Node and npm
versions, and `.npmrc` makes incompatible engines fail installation. Use your
preferred version manager to select the pinned runtime. Do not override
`engine-strict` to bypass a mismatch.

With those versions available, run from the repository root:

```text
npm ci
npm run toolchain:versions
```

Commit the root `package-lock.json`. Install dependencies from the root, target
the relevant workspace when it exists, and avoid nested lockfiles. New direct
dependencies are saved with exact versions.

The workspace patterns use `apps/*` for applications and `packages/*` for shared
contracts. Workspaces are `@real-time-chat/api` in `apps/api` and
`@real-time-chat/web` in `apps/web`. TypeScript
projects extend `tsconfig.base.json`, with module, target, and framework options
defined in their own configuration.

TypeScript 6.0 was selected against the
[Angular compatibility table](https://angular.dev/reference/versions) and the
published Nest CLI 12.0.8 dependency on `~6.0.2`. Node 24 is compatible with the
planned frameworks and npm 12.1.0. The API uses NestJS 12.1.2 with ESM and the
Express adapter. Compilation uses TypeScript directly; tests use Node's built-in
runner and real HTTP requests.

## Run the API on the host

Copy `.env.example` to `.env` in the repository root (`Copy-Item .env.example .env`
in PowerShell, or `cp .env.example .env` on Unix). Preserve an existing `.env`.
Configure PostgreSQL as described below and set `DATABASE_URL` before running:

```text
npm ci
docker compose -f compose.yaml -f compose.host.yaml up -d --wait db
npm run db:migrate:deploy --workspace @real-time-chat/api
npm run build
npm start
```

`GET http://127.0.0.1:3000/api/health/live` returns HTTP 200 with
`{"status":"ok"}`. This checks that the HTTP process is alive; database readiness
will be added when database integration exists. Stop the server with Ctrl+C.

| Variable | Contract |
| --- | --- |
| `NODE_ENV` | Required: `development`, `test`, or `production` |
| `PORT` | Required: integer from 1 through 65535 |
| `HOST` | Optional IP address; defaults to `127.0.0.1`. Containers will use `0.0.0.0`. |
| `DATABASE_URL` | Required PostgreSQL URL including a database name; keep credentials in `.env`. |

Startup rejects missing/invalid configuration or an unavailable database with a
nonzero exit code. Nest closes the Prisma connection pool when the app closes.
`npm start` loads the root `.env` if present; process environment variables take
precedence. Validation errors name the variable without echoing its value.

Verification commands (from the root):

```text
npm test
npm run typecheck
npm run build
```

Tests use isolated configuration and an ephemeral HTTP port, so they do not
require `.env` or a running API. For development, run
`npm run build:watch --workspace @real-time-chat/api` in one terminal and, after
the first build, `npm run start:watch --workspace @real-time-chat/api` in another.
Run `npm run lint` from the root for TypeScript, JavaScript and Angular template
checks, including template accessibility. Generated files are excluded.

## Run the web on the host

With the API running in one terminal, open another at the repository root:

```text
npm run start:web
```

Open <http://127.0.0.1:4200>. The page requests `/api/health/live` on the same
origin. Angular's development server proxies `/api/**` to `127.0.0.1:3000` using
`apps/web/proxy.conf.json`. If you change the API port, update that target and
restart the web server. This proxy only applies to development; serving the
production build uses the Nginx API reverse proxy in the Docker setup above.

Stop the API and select **Check again** to see the error state. Restart it and
select **Try again** to recover. A request times out after five seconds, and
the button stays disabled while loading. This is a manual liveness check, not
continuous monitoring or messaging readiness.

Angular 22.2.1 uses standalone components, signals and strict template checking;
the CLI/build tools are pinned to 22.2.2. The shell has a single Overview page,
semantic navigation and a keyboard skip link. Routing will be added with the
first additional screen.

Root `npm run build`, `npm run typecheck` and `npm test` check both applications.
Use `npm run build --workspace @real-time-chat/web` (or `typecheck` / `test`) for
web-only checks. Component tests use Angular's HTTP testing backend and Vitest;
no running API is required. Production web output is in `apps/web/dist/browser`.

## HTTP error contract

Nest HTTP failures return `{ code, message, requestId }`. `message` is fixed public
text; exception messages, stacks, request URLs and database details are never
copied into the response. Clients decide by `code`, not by message text.

| HTTP status | Code |
| --- | --- |
| 400 | `VALIDATION_ERROR` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |

Unmapped exceptions/statuses currently normalize to 500; extend this mapping
when an endpoint needs another HTTP semantic. A fresh server UUID v4 appears in
the body and `X-Request-Id` header for each error, with `Cache-Control: no-store`.
Incoming request IDs are not trusted. Internal failures log only code/requestId;
full request tracing and structured diagnostics belong to the observability stage.
Successful responses keep their existing shape. Proxy/network failures may not
follow this contract, so Angular retains its generic connection-error fallback.

The existing connection UI recognizes validated server errors and gives a
specific retry message for rate limiting. It never renders server-provided text.
No error-only endpoint is exposed: requesting `/api/missing` exercises the
404 contract. HTTP tests use isolated controllers for the other failure cases.
Field-level validation errors will be introduced with the registration form.

`@real-time-chat/contracts` is a private npm workspace containing the TypeScript
contract and `isApiError` runtime guard. Package exports point to generated JS
and declarations, so Node and Angular resolve the same package without custom
runtime path aliases. Consumer build/test/typecheck hooks build it first; web
startup does too. Docker images include the package independently of host output.
After editing shared contracts in Docker development, use the rebuild sequence
above. For host development, rebuild the package and restart the consumers.

The filter uses Nest's documented
[global exception filter registration](https://docs.nestjs.com/exception-filters).

## Local execution target

### PostgreSQL now

Use Docker Desktop with Linux containers (Windows/macOS) or Docker Engine with
Compose on Linux. Copy `.env.example` to `.env` only if it does not already exist;
otherwise add the new `POSTGRES_*` entries without overwriting your configuration.
Set a non-empty, locally generated `POSTGRES_PASSWORD`; the example deliberately
has no default password. For example, generate one using PowerShell:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
```

Or on Unix: `openssl rand -hex 24`. Paste the result into your ignored `.env`.
Do not commit it. Then run from the repository root:

```text
docker compose config --quiet
docker compose up -d --wait db
docker compose ps
```

The pinned [official PostgreSQL image](https://hub.docker.com/_/postgres) is
`18.6-bookworm`. Its data volume mounts `/var/lib/postgresql`, the image's
PostgreSQL 18+ layout. The health check waits for PostgreSQL to accept connections;
it does not verify application migrations or readiness.

| Variable | Local use |
| --- | --- |
| `POSTGRES_DB` | Required database name; example: `real_time_chat` |
| `POSTGRES_USER` | Required bootstrap administrator; example: `chat_local` |
| `POSTGRES_PASSWORD` | Required private password, no default |
| `POSTGRES_PORT` | Optional host development port, defaults to `5432`; only used by `compose.host.yaml` |
| `WEB_PORT` | Docker web port, defaults to `8080` |

By default PostgreSQL has no published port. To use a host SQL client, Prisma or
the host API, explicitly start it with
`docker compose -f compose.yaml -f compose.host.yaml up -d --wait db`.
That override publishes `127.0.0.1:${POSTGRES_PORT}` only. Use the same `-f` pair
for subsequent host-development Compose commands; the default stack needs no
override. The API uses this bootstrap administrator for local
development; restricted application credentials belong to future deployment preparation.
Changing initialization credentials in `.env` does not update an existing
database; use SQL to change existing roles/passwords instead.

Open an authenticated TCP session using the client inside the container (the
single quotes work in PowerShell and Unix shells):

```text
docker compose exec db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h db -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

The service hostname `db` exercises network password authentication; the official
image trusts local connections inside the container.

For a persistence check on your local database, create a disposable record:

```sql
CREATE TABLE persistence_check (id integer PRIMARY KEY, note text NOT NULL);
INSERT INTO persistence_check VALUES (1, 'kept after recreation');
```

Exit with `\q`, run `docker compose down`, then `docker compose up -d --wait db`.
Reconnect and run `SELECT * FROM persistence_check;` to confirm the row survived.
Remove only this test table with `DROP TABLE persistence_check;` afterwards.

`docker compose stop db` stops the database; `docker compose start db` resumes it.
`docker compose down` removes the container/network but retains the named volume
`real-time-chat_postgres_data`. **Do not use `down --volumes` to stop the stack:**
it deletes the stored database. A volume provides persistence, not a backup.

### Prisma and migrations

Set `DATABASE_URL` in `.env` to
`postgresql://USER:PASSWORD@127.0.0.1:5432/real_time_chat`, using your actual
`POSTGRES_*` values and URL-encoding special characters in the credentials.
The example intentionally leaves connection URLs empty; Compose interpolation
does not apply to Node's environment loader. Prisma 7.10.0 uses the PostgreSQL
driver adapter and an ESM client generated into ignored source files.

```text
npm run db:generate --workspace @real-time-chat/api
npm run db:migrate:dev --workspace @real-time-chat/api -- --name describe_change
npm run db:migrate:deploy --workspace @real-time-chat/api
```

Use `migrate:dev` only to create migrations on a development database (it needs
permission to create a shadow database). Commit the schema and generated SQL
migration together. Use `migrate:deploy` to apply committed migrations to a fresh
database or later deployment; it never creates a migration or resets data. The
API does not run migrations itself; Compose runs the separate migration job.
Build, typecheck and test commands
generate the client first; after schema edits during watch mode, run
`db:generate` again. Generation does not require a running database.

The initial schema has UUID users, unique normalized email values, password
hashes, and sessions with unique token hashes, expiry/user indexes and a foreign
key that restricts user deletion. Email normalization and actual password/token
hashing belong to the authentication tasks; these tables do not implement login.

Integration tests use a **separate database whose name ends in `_test`**. Create
it once in the local SQL session and set `TEST_DATABASE_URL` to its full URL:

```sql
CREATE DATABASE real_time_chat_test;
```

```text
npm run test:integration --workspace @real-time-chat/api
```

The suite refuses a missing URL or the development database name, applies the
committed migrations, checks constraints/rollback against real PostgreSQL, and
removes only its own test records. It also checks that closing Nest releases its
connection. The test database and migration history remain for subsequent runs.
Ordinary `npm test` stays database-independent; integration tests are explicit
and fail rather than skip when PostgreSQL/configuration is unavailable.

CLI dependency overrides pin `deepmerge-ts` 8.0.2 and `mysql2` 3.24.5 to address
[recursive merge exhaustion](https://github.com/advisories/GHSA-ggr8-5vv4-36mx),
[MySQL authentication downgrade](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr)
and [decompression exhaustion](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3).
Remove these overrides when a stable Prisma release includes corrected versions;
regenerate the lockfile and verify generation/migrations before doing so.

### Remaining delivery work

Application features and demo seed data remain in the plan.
Remote hosting is outside the current delivery scope.

## Account registration API

Set `APP_ORIGIN` to the exact browser origin, without a trailing slash. It defaults
to `http://127.0.0.1:8080`; update it when changing `WEB_PORT`, using `localhost`
instead of `127.0.0.1`, or running Angular on port 4200. HTTP is accepted only for
loopback development; other origins require HTTPS. Restart the API after changes.

1. `GET /api/auth/csrf` with the matching `Origin` (or same-origin browser
   `Referer`) returns `{ "csrfToken": "…" }` and an HttpOnly pre-auth cookie.
2. `POST /api/auth/register` with that cookie, matching `Origin`,
   `X-CSRF-Token`, and `Content-Type: application/json` accepts:

   ```json
   { "email": "person@example.test", "displayName": "María", "password": "a long unique passphrase" }
   ```

3. Success is `201` with `{ "user": { "id": "…", "email": "…",
   "displayName": "…", "createdAt": "…" } }`. No password hash or session is
   returned. The UI continues to `/login`, which currently confirms registration
   and explains that sign-in is not yet available.

Email is trimmed and lowercased (ASCII email addresses, at most 254 characters);
provider-specific dot/plus rewriting is not performed. Display names are trimmed,
NFC-normalized, and accept 2–80 Unicode characters: letters, marks, numbers, spaces,
apostrophes, periods and hyphens. Passwords preserve their exact input and accept
15–128 Unicode characters, without composition rules. Unknown fields are rejected.

Errors use the shared `ApiError` contract: `400 VALIDATION_ERROR` (optional safe
`fieldErrors` for email/displayName/password), `403 FORBIDDEN` for missing or invalid
CSRF/origin, `409 CONFLICT` for an existing normalized email, and
`413 VALIDATION_ERROR` for JSON over 8 KB. Unexpected failures remain generic.
Registration and token responses use `Cache-Control: no-store`.

Passwords use Node's asynchronous native Argon2id with a random 16-byte salt,
19 MiB memory, two iterations, one lane and a 32-byte hash, stored in PHC format.
These parameters follow the
[OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
The [Node crypto API](https://nodejs.org/api/crypto.html#cryptoargon2algorithm-parameters-callback)
is currently release-candidate stability; the repository pins its Node runtime and
tests hash reproduction. No additional hashing runtime dependency is installed.

Pre-auth CSRF uses a random nonce and expiry signed with HMAC-SHA256, matched
between cookie and header, plus an exact origin check. The cookie expires after
10 minutes, uses `Path=/`, HttpOnly and SameSite=Lax; HTTPS additionally uses
Secure and the `__Host-` prefix. The signing key lives in one API process, so
restart requires a fresh bootstrap. Multiple API replicas require shared key
management; authenticated session binding belongs to the session task, following
the [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
Host/forwarded headers do not determine the trusted origin. Rate limiting remains
in task 4.1a. Database uniqueness resolves concurrent duplicate registrations.

Integration tests exercise these endpoints against real PostgreSQL, including
concurrent duplicates, invalid fields, malformed/oversized JSON, CSRF failures,
public response fields, and absence of an automatically created session.

### Browser verification

The registration form uses Angular reactive forms with native labels, autocomplete,
field descriptions, error focus and keyboard submission. The browser sends cookies
on same-origin requests; the client fetches a fresh CSRF token for each attempt.
It keeps credentials and tokens out of browser storage and URLs, prevents duplicate
submissions, and cancels requests on navigation. A 15-second timeout reports an
unconfirmed outcome without automatically repeating a possibly completed POST.
Server validation remains authoritative; server text is replaced with local copy.

The first Playwright test uses Chromium against a real Compose stack. It creates
accounts, so use an isolated project and environment file. Copy `.env.example` to
`.env.e2e`, set a private password, `WEB_PORT=18083` and
`APP_ORIGIN=http://127.0.0.1:18083`, then run:

```text
docker compose -p chat-e2e --env-file .env.e2e up --build --wait
npx playwright install chromium
```

Set `E2E_BASE_URL=http://127.0.0.1:18083` in your shell (`$env:E2E_BASE_URL =
'http://127.0.0.1:18083'` in PowerShell; `export E2E_BASE_URL=http://127.0.0.1:18083`
in Bash), then run `npm run test:e2e`. The suite requires this explicit URL. It
checks a real registration and duplicate, an injected server failure followed by
recovery, single submission, keyboard focus, and widths 320/768/1024/1440. Screenshots
for visual review are written to ignored `test-results/`; traces are disabled.

Stop only this test stack with `docker compose -p chat-e2e --env-file .env.e2e down`.
Its dedicated volume retains synthetic accounts between runs; each run uses unique
emails. The ordinary development volume is separate. CI uses a disposable stack.

## Continuous integration

[CI](https://github.com/MatteoMurcia/real-time-chat/actions/workflows/ci.yml)
runs on every pull request targeting `main` and every push to `main`.

- **Quality:** pinned Node/npm, lockfile installation, lint (zero warnings),
  typecheck, unit/contract tests, Docker configuration tests, builds, dependency
  audit (high/critical vulnerabilities fail), and integration tests with an
  isolated PostgreSQL 18.6 database.
- **Containers:** build the Compose images, apply migrations to an empty volume,
  wait for healthy services, verify the public health response through Nginx,
  and run the Chromium registration E2E against that stack.

Jobs use read-only repository permissions and actions pinned to commit SHAs.
Only npm's download cache is reused, keyed by the lockfile; `npm ci` still checks
the dependency tree. Database passwords are generated per run and masked, so
fork pull requests need no repository secrets. Temporary databases are removed
even after failed checks; diagnostics run on failure. Superseded runs are cancelled.
There is no deployment, registry push or automatic merge.

Run the code checks locally with the pinned toolchain:

```text
npm ci
npm run lint
npm run typecheck
npm test
npm run test:docker
npm run build
npm audit --audit-level=high
```

For integration, follow the separate test database setup above and run
`npm run test:integration --workspace @real-time-chat/api`. For the container
check, use the documented `docker compose up --build --wait` flow. CI runs these
checks on disposable Ubuntu runners; do not copy its volume-deletion cleanup
commands to your persistent local database.

## Repository hygiene

Environment files, credentials, dependencies, build output, and test artifacts
are excluded from version control. Environment templates such as `.env.example`
will be tracked when introduced. Dependency lockfiles and database migrations
will also be tracked.
