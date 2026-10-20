# Local demonstration seed

This optional tool creates fictional **Alice Rivera** and **Bob Chen**, two
channels and 111 messages: **Demo Lounge** has 105 messages (three 50-item history
pages), and **Demo Planning** has six. Both accounts belong to both channels.
It creates no login sessions and does not run when the application starts.
For the separate demo installation, two-session access and guarded manual reset,
start with [demo access and maintenance](demo.md). The commands below describe
adding seed data to the ordinary local stack; they do not enable reset there.

## Run with Docker only

Follow the root README's Compose setup and fill `.env` locally. In addition to
the database password, set `DEMO_ALICE_PASSWORD` and `DEMO_BOB_PASSWORD` to your
own local-demo passphrases of 15–128 Unicode characters. Do not reuse a personal
password or commit this file. The app's registration validator and Argon2id
hasher are reused; there are no built-in passwords. Ordinary startup does not
require these two optional values.

```text
docker compose up --build --wait
docker compose --profile tools build seed
docker compose --profile tools run --rm seed
docker compose --profile tools run --rm seed
```

The seed image contains compiled code and the required runtime/tools. The host
needs Docker Compose, not Node/npm or PostgreSQL. `seed` is a one-shot non-root
service in the `tools` profile, on the internal backend network. It waits for a
healthy database and successful migrations. It uses the same `POSTGRES_*` target
as the app; host `DATABASE_URL` does not configure the container.

Open the configured local URL in two separate browser sessions (for example,
one normal window and one private window):

| Account | Password source |
| --- | --- |
| `alice@demo.example.test` | `DEMO_ALICE_PASSWORD` in the local environment file |
| `bob@demo.example.test` | `DEMO_BOB_PASSWORD` in the local environment file |

Open **Demo Lounge** and load earlier messages twice to see all 105. Use **Demo
Planning** for a shorter conversation. Accounts/channels are shared demo data
inside this local database, not private sandboxes. Run only on a database where
you intend to add these fictional accounts; never point a public demo at real
user data. Seeding never deletes data. The separate [demo maintenance procedure](demo.md#reset-manually)
provides an explicit reset restricted to the dedicated demo installation.

## Reruns and collisions

All changes occur in one transaction. Fixed reserved user/channel IDs and
author/client-message keys prevent duplicates. An advisory transaction lock
serializes seed runs; channel writes reuse the app's channel lock before
incrementing sequences. Existing messages, hashes, IDs and timestamps remain
unchanged, including messages added after seeding. Missing demo memberships or
sample messages can be added again; a restored sample receives a new sequence.

An existing reserved email/slug/name/key owned by different data, changed sample
content, or a different password for an already seeded account causes failure
and rollback. The tool does not take over an existing account or silently rotate
its password. Keep the original environment values for repeat runs. Errors and
success output contain no passwords or database URLs. A generic error is
intentional; check configuration and reserved records locally. It never clears
the database to resolve a collision.

For optional host development, use `npm run db:seed --workspace @real-time-chat/api`
with `DATABASE_URL` and the demo passwords configured. Prisma's explicit
`npm run prisma --workspace @real-time-chat/api -- db seed` is also wired through
`prisma.config.ts`; it does not run automatically during migrations. See
[Prisma v7 seeding](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/seeding).

## Verification

`test/seed.spec.ts` checks missing/invalid credentials and CLI redaction.
`test/integration/demo-seed.ts` runs the seed repeatedly and concurrently in a
fresh database, compares complete row fingerprints, preserves unrelated data and
later conversation, verifies both logins and 50/50/5 history pages, and forces
password, message, channel and email collisions without appropriating data.
CI runs the exact Compose seed command twice before browser tests;
`e2e/demo-seed.spec.ts` then signs in both real accounts in independent contexts
and checks the populated channels/history. All credentials and data in that
verification are synthetic. E2E traces are unredacted; use only the disposable
stack described in the README.

[CI 39313659571](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39313659571)
on `26c6e27` passed all three jobs: 53 API, 103 Angular, three contract tests,
five Docker checks, 23 integration results per order, 28 Chromium E2Es and six
usability repetitions. The compiled seed command succeeded twice; both account
logins and 105/6-message channel histories passed in the browser. Database cleanup,
temporary-stack teardown and report uploads passed; dependency audit found no
vulnerabilities and tests used no skips or retries.

Local lint, types, all unit suites, app builds and the seed build also pass. A
temporary mutation adding a fallback password failed the credential test; source
was restored and all checks returned green. Compose configuration was checked
without a daemon: ordinary startup excludes `seed`, while `--profile tools`
includes it. During 5.1a verification the local Docker engine was unavailable,
so its real database/container evidence came from Linux CI. Independent and
parent review found no remaining required changes; [PR #53](https://github.com/MatteoMurcia/real-time-chat/pull/53)
is merged. Subsequent [access/reset verification](demo.md) and
[clean-checkout installation](installation-verification.md) include local Docker
evidence from 5.1b/5.2a. Presentation and final delivery remain separate from the
seed test; follow the [current plan](../tasks/plan.md).
