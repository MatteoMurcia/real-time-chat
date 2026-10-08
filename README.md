# Real-time Chat

[GitHub repository](https://github.com/MatteoMurcia/real-time-chat)

A fullstack portfolio project focused on reliable team messaging: persistent
conversations, explicit channel permissions, idempotent sends, and recovery after
connection failures.

## Project status

The Angular web scaffold and NestJS API run locally. The initial page checks API
liveness and displays loading, failure, and recovery states. Environment
validation, HTTP/component tests, and strict TypeScript checks are available.
Database, chat features, and Docker setup are still pending.

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
in PowerShell, or `cp .env.example .env` on Unix). Then run:

```text
npm ci
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

Startup rejects missing/invalid configuration with a nonzero exit code.
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
