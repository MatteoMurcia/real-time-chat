# Real-time Chat

[GitHub repository](https://github.com/MatteoMurcia/real-time-chat)

A fullstack portfolio project focused on reliable team messaging: persistent
conversations, explicit channel permissions, idempotent sends, and recovery after
connection failures.

## Project status

The GitHub repository, npm workspace configuration, and shared TypeScript settings
are ready. Application development has not started; there are no runnable
services or Docker images at this stage.

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

The workspace patterns reserve `apps/*` for the API/web applications and
`packages/*` for shared contracts. These packages will be created by their plan
tasks; no empty application packages are registered yet. Each future TypeScript
project must extend `tsconfig.base.json`, with module, target, and framework
options defined in its own configuration.

TypeScript 6.0 was selected against the
[Angular compatibility table](https://angular.dev/reference/versions) and the
published Nest CLI 12.0.8 dependency on `~6.0.2`. Node 24 is compatible with the
planned frameworks and npm 12.1.0. Framework dependencies and their exact versions
will be installed and verified in the application tasks.

There are no application build, test, or lint commands yet. Those commands will
be introduced alongside the corresponding source code and tools.

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
