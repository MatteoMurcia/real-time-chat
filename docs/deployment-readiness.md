# Local delivery and future deployment requirements

The supported delivery is a **single API running locally in Docker Compose**.
There is no hosted environment, registry publication, deployment pipeline or
production readiness claim. The [delivery verification](delivery-verification.md)
records the tested commit, Docker environment, two-user smoke and persistence
checks. [CP5-B](../tasks/plan.md#etapa-5--demo-local-y-entrega-en-github)
remains a separate acceptance review.

## Identify what is running

Record `git rev-parse HEAD` before building, retain the root lockfile and use
the documented [Docker installation](../README.md#run-everything-with-docker).
`package.json` still says `0.0.0`; this task records the verified Git commit rather
than publishing a release tag or declaring v1 complete. Application changes need
a new verification against their own commit; the earlier video is presentation
evidence, not a substitute for that smoke test.

The Dockerfiles pin Node, npm and Nginx versions; Compose pins the PostgreSQL
image tag. The lockfile
pins JavaScript dependencies. Tags and operating-system package downloads are
not immutable image digests, so a clean checkout does not promise bit-identical
images or a completely offline build. BuildKit may reuse layers. Keep image IDs
and build logs when auditing a particular run.

## Local update and recovery

Keep the environment credentials and PostgreSQL volume together. Before changing
application versions, stop the existing stack with `docker compose down` without
`--volumes`, check out the intended commit, then run
`docker compose up --build --wait`. Use the demo guide's explicit project,
environment and override arguments when operating the [dedicated demo](demo.md).
The migration job must exit successfully before API/web startup. Do not migrate
an already running API in place or use a volume reset to repair startup.

Check public `/api/health/live` and `/api/health/ready`, container health, two
independent sign-ins, a confirmed cross-session message and reconnect recovery.
After recreation, confirm sessions, memberships and saved message IDs/content
remain available. Normal down/up preserves the named volume; **it is not a
backup**. Keep [operations](operations.md) available for diagnostics and shutdown.

Rolling code back cannot automatically roll the schema back. Before any future
release, assess migration compatibility and a tested database restore procedure.
No downgrade or zero-downtime upgrade is certified by this local smoke.

## Requirements before any remote deployment

These are outstanding engineering requirements, not instructions to expose this
Compose file to the internet.

| Area | Work required for the chosen environment |
| --- | --- |
| HTTPS and browser origin | Provide TLS and set `APP_ORIGIN` to the exact HTTPS browser origin. Current Nginx serves HTTP on port 8080 and Compose publishes it only on `127.0.0.1`. Changing the origin or binding alone is insufficient. Route `/api/` and `/socket.io/` to the same browser origin, including WebSocket upgrades and appropriate idle timeouts. |
| Proxy trust | Review every ingress hop, observed client IP and forwarded header. Current Nginx overwrites forwarding headers using its own peer/scheme; an added TLS proxy changes that chain. Keep `PROXY_IP` and API `TRUSTED_PROXY_IPS` consistent with actual trusted peers, and verify spoofed forwarding headers cannot bypass quotas. |
| Cookies and browser policy | HTTPS `APP_ORIGIN` selects `__Host-chat_session` with `Secure`, `HttpOnly`, `SameSite=Lax` and path `/`; loopback HTTP uses `chat_session`. Verify real browser cookies, CSRF and Origin checks behind the chosen ingress. Review CSP, HSTS and other deployment-specific headers; local HTTP has no HSTS. |
| Access and abuse | Registration is open. Any registered user can join an open channel and read its previous history. Define who may register, privacy/retention expectations and abuse controls before exposing it. Existing in-process quotas are not general denial-of-service protection. |
| Secrets and database roles | Supply secrets through the chosen platform, rotate them and keep them out of images/logs. Current Compose shares PostgreSQL bootstrap credentials between API, migrations and tools. Separate least-privilege runtime/migration roles need configuration/image changes; there is no existing runtime-role switch. |
| Durable storage and backup | Choose persistent database storage, restricted network access and encrypted connections where required. Define retention, encrypted backups, restore exercises and recovery objectives. A local named volume does not cover host/storage failure. |
| Rollout and migration | Build and retain immutable artifacts for a known commit, scan them, serialize migrations, and establish compatibility, drain, rollback/restore and failure procedures. Current CI checks quality and containers but does not publish or deploy them. |
| Health and operations | Configure platform traffic admission, restart policy, monitoring and alert ownership. Readiness checks database reachability, not schema compatibility or write capacity; Docker unhealthy status alone does not restart containers or remove traffic. Preserve the API's 8-second shutdown budget and an outer grace period longer than it (Compose uses 12 seconds). |
| Scale and load | Keep one API instance until coordination is designed and tested. CSRF signing keys, quota buckets, subscriptions and revocation delivery include process-local state. Additional replicas need shared coordination/state and appropriate transport routing. No capacity, high availability or multi-instance guarantee has been measured. |

The existing [security boundaries](security-boundaries.md),
[traffic limits](traffic-limits.md), [architecture](architecture.md) and
[message guarantees](decisions/004-message-guarantees.md) explain the current
contracts. Persistence is ordered and retryable by idempotency key; live events
are best-effort. Bounded recovery repairs the visible channel. There is no durable
outgoing queue, offline-first mode, outbox or exactly-once delivery.

No provider, domain, certificate, public port, cloud account or deployment
resource is created by 5.3a. Remote deployment requires its own implementation
and verification against these requirements.
