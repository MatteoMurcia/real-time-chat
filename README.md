# Real-time Chat

[GitHub repository](https://github.com/MatteoMurcia/real-time-chat)

A fullstack portfolio project focused on reliable team messaging: persistent
conversations, explicit channel permissions, idempotent sends, and recovery after
connection failures.

## Project status

The Angular web scaffold and NestJS API run locally. The initial page checks API
liveness and displays loading, failure, and recovery states. Environment
validation, HTTP/component tests, and strict TypeScript checks are available.
PostgreSQL runs locally through Docker Compose with persistent storage. Prisma
manages the User/Session schema and the API database connection lifecycle.
Authentication/chat features and application containers are still pending.

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

## Development toolchain

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

## Run the API

Copy `.env.example` to `.env` in the repository root (`Copy-Item .env.example .env`
in PowerShell, or `cp .env.example .env` on Unix). Preserve an existing `.env`.
Configure PostgreSQL as described below and set `DATABASE_URL` before running:

```text
npm ci
docker compose up -d --wait db
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
Lint and CI will be configured in task 0.3b.

## Run the web

With the API running in one terminal, open another at the repository root:

```text
npm run start:web
```

Open <http://127.0.0.1:4200>. The page requests `/api/health/live` on the same
origin. Angular's development server proxies `/api/**` to `127.0.0.1:3000` using
`apps/web/proxy.conf.json`. If you change the API port, update that target and
restart the web server. This proxy only applies to development; serving the
production build with an API reverse proxy belongs to the Docker setup in 0.2c.

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
| `POSTGRES_PORT` | Host port, defaults to `5432`; change if occupied |

Only `127.0.0.1` exposes the database port for host development. A SQL client can
connect with these values. The API uses this bootstrap administrator for local
development; restricted application credentials belong to future deployment preparation.
The complete container setup in 0.2c will move database access to the internal
network. Changing initialization credentials in `.env` does not update an existing
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
API does not run migrations automatically. Build, typecheck and test commands
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

### Complete application (planned)

The application will run locally in containers. The completed setup will include
the frontend, API, database, migrations, and an explicit demo seed command.
Running the demo should require Git and Docker with Compose, without installing
Node.js or PostgreSQL on the host.

Containers, environment configuration, and documented migrations will make a
later deployment easier. Remote hosting is outside the current delivery scope.

## Repository hygiene

Environment files, credentials, dependencies, build output, and test artifacts
are excluded from version control. Environment templates such as `.env.example`
will be tracked when introduced. Dependency lockfiles and database migrations
will also be tracked.
