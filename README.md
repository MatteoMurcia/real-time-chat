# Real-time Chat

[GitHub repository](https://github.com/MatteoMurcia/real-time-chat)

A fullstack portfolio project focused on reliable team messaging: persistent
conversations, explicit channel permissions, idempotent sends, and recovery after
connection failures.

## Project status

The GitHub repository and initial project documentation are ready. The
application has not been implemented yet; there are no runnable services or
Docker images at this stage.

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

Versions and executable commands will be documented as the project is initialized.

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
