# CP5-B — Final local portfolio acceptance

Reviewed on **2026-10-20** against integrated `main`
`3d99c499641e27e69d942cdb1b0ce21a35673d1e` (5.3a merged through PR #58).
This review covers the A01–A18 acceptance matrix, the portfolio evidence and
the explicitly outstanding CP0-C/CP1-C gates. It does not deploy the application,
publish images, create a release tag or implement stage 6 features.

## Acceptance evidence

Each row below names executable assertions or a recorded execution, rather than
treating a written scenario as proof. Integration helpers are invoked by
[`database.spec.ts`](../../apps/api/test/integration/database.spec.ts), including
the message, lock-race, subscription, session and suppressed-emission cases.
The [CI workflow](../../.github/workflows/ci.yml) runs that suite against fresh
PostgreSQL databases in both orders; it also runs the Angular/API/contract and
Docker suites, then the full Chromium E2E suite against the compiled Compose app.
Playwright uses one worker, zero retries and forbids focused tests in CI.

| ID | Executed evidence | Assertion reviewed |
| --- | --- | --- |
| A01 | [Registration](../../e2e/register.spec.ts), [sessions](../../e2e/session.spec.ts) | Registration redirects to login; identity survives reload; logout rejects the old cookie while another session remains valid. |
| A02 | [Subscriptions](../../e2e/subscriptions.spec.ts), [local smoke](../delivery-verification.md#two-user-authorization-and-recovery-smoke) | A nonmember cannot read history/sync, subscribe or send; authenticating alone does not grant channel access. |
| A03 | [Concurrent writes](../../apps/api/test/integration/messages.ts), [message order](../../e2e/message-order.spec.ts) | Ten concurrent sends with the same key return the same canonical result; one persisted message and one UI row remain. |
| A04 | [Idempotency races](../../apps/api/test/integration/message-idempotency.ts), [conflicting bodies](../../e2e/message-order.spec.ts) | A reused author/key with different channel or content conflicts without a second write; membership is still checked. |
| A05 | [Lost confirmation](../../e2e/message-retry.spec.ts), [message persistence](../../apps/api/test/integration/messages.ts) | Real ack/event frames are dropped after persistence; retries retain the exact key/body and recover the original message. |
| A06 | [Frame order](../../e2e/message-order.spec.ts) | Held real event/ack frames are released in both orders; one canonical row remains and pending state clears. |
| A07 | [Restart and three-page recovery](../../e2e/reconnect.spec.ts) | 105 missed messages recover with exact ordered IDs, a fixed upper bound and the retained draft after API restart. |
| A08 | [Suppressed emission](../../apps/api/test/integration/commit-emission.ts), [browser gap](../../e2e/sync-gap.spec.ts), [periodic dispatch](../../apps/web/src/app/features/chat/chat.store.spec.ts) | A committed but unemitted message is recoverable while the receiver stays connected; browser reconciliation and 15-second visible-tab scheduling are checked separately. See the qualification below. |
| A09 | [Commit-boundary races](../../apps/api/test/integration/message-sync-races.ts) | A held real transaction blocks recovery/concurrent sending; commit and rollback leave no committed message behind the recovery boundary. |
| A10 | [Channel races](../../e2e/channel-races.spec.ts), [store races](../../apps/web/src/app/features/chat/chat.store.races.spec.ts) | Snapshot/live events merge once; delayed A/B/A responses cannot mix views, and live events do not advance the HTTP recovery cursor. |
| A11 | [Authorization races](../../apps/api/test/integration/subscriptions.ts) | Subscribe/send versus leave run in both controlled orders under the channel lock; acceptance follows that order and revoked rooms are removed. |
| A12 | [Socket lifecycle](../../apps/api/test/integration/socket-session.ts), [browser revocation](../../e2e/session-revocation.spec.ts) | Logout closes all sockets of one session; two idle sockets expire on a short real deadline; unrelated sessions remain valid, and revoked offline reconnects fail. |
| A13 | [HTTP/CSRF integration](../../apps/api/test/integration/database.spec.ts), [forged requests](../../e2e/subscriptions.spec.ts), [literal HTML](../../e2e/conversation.spec.ts), [headers](../../e2e/security-headers.spec.ts) | Foreign origin, missing CSRF and forged author are rejected; hostile HTML stays text in live/history views and security headers do not break the app. |
| A14 | [Reconnect](../../e2e/reconnect.spec.ts), [shutdown](../../e2e/shutdown.spec.ts), [local smoke](../delivery-verification.md#two-user-authorization-and-recovery-smoke) | The real API restarts; persisted history converges and a lost confirmation can be retried with its original key. |
| A15 | [History scroll](../../e2e/history-scroll.spec.ts) | The visible message ID and position remain anchored within 2px through older-page loading, live arrivals and retry at desktop/mobile widths. |
| A16 | [Keyboard](../../e2e/keyboard.spec.ts), [responsive lifecycle](../../e2e/responsive.spec.ts), [store disposal](../../apps/web/src/app/features/chat/chat.store.lifecycle.spec.ts) | Keyboard flow, reduced viewport, twenty channel changes/remounts and listener/timer cleanup have assertions; CI additionally repeats keyboard/responsive tests three times each. |
| A17 | [Clean-clone delivery](../delivery-verification.md#clean-source-and-environment), [initial installation](../installation-verification.md) | A GitHub clone builds/migrates/seeds/runs through Docker without host application dependencies; database starts empty and seed can run twice. |
| A18 | [Two-user delivery](../delivery-verification.md#two-user-authorization-and-recovery-smoke), [recreation](../delivery-verification.md#full-recreation-and-persistence) | Independent users pass permissions/restart/recovery smoke; down/up retains sessions, memberships, all saved message rows and selected ordered IDs, followed by another confirmed send. |

A08 is **composite evidence**. Integration suppresses emission deterministically,
then recovers using the connected receiver's authorized HTTP request. The browser
test releases a pending periodic request or explicitly triggers focus. An Angular
fake-timer test proves periodic dispatch without focus. This is not a single
full-stack autonomous-timer test or a process killed at the exact commit instant.
These tests call the same implemented recovery path; no stronger fault or timing
guarantee is inferred.

A17/A18 were executed by an automated agent-operated QA driver on `51eb848`, as
recorded in 5.3a; they are distinct from CI and human usability tests. Comparison
against `3d99c49` found **no differences** in applications, contracts, Dockerfiles,
Compose files, lockfile/runtime configuration or CI workflow. CP5-B audits that
execution and its unchanged implementation, rather than claiming a new local
installation run. The merged tree contains the versioned plan and safe templates.

## Explicit review of CP0-C and CP1-C

These gates were still pending before this checkpoint. They are reviewed here
explicitly using their original criteria, not inferred from completed task boxes.

**CP0-C evidence:** clean-clone Docker startup/seed/persistence is recorded by
[5.3a](../delivery-verification.md), with earlier independent installation in
[CP5-A](cp5-a.md). The current GitHub suite and tracked plan provide the CI and
versioning evidence. A read-only GitHub branch-protection query confirmed:

- PRs required, including administrators; zero external approvals for this solo project.
- Required `Quality` and `Containers` checks from GitHub Actions (app 15368), with strict/up-to-date enforcement.
- Linear history and resolved review conversations required; force pushes and deletion of `main` disabled.

`Integration` executes and its result is reviewed, but it is **not** configured
as a required branch-protection check. No repository setting was changed. The
owner must inspect all three CI results before merge; this distinction is also
recorded in [Contributing](../../CONTRIBUTING.md).

**CP1-C evidence:** [handshake](../../e2e/handshake.spec.ts),
[session](../../e2e/session.spec.ts), [revocation](../../e2e/session-revocation.spec.ts)
and [persistence](../../e2e/persistence.spec.ts) tests run through Nginx against
the compiled API/database, covering authentication, reload/logout, rejected
identity, Socket.IO reconnect and retained sessions. The 5.3a local two-context
smoke independently exercises sign-in, live delivery and restart. A public host,
domain or certificate was never part of either gate's acceptance criteria.

## Portfolio package and scope

The English [README](../../README.md), [architecture and ADRs](../architecture.md),
[demo access/reset guide](../demo.md), [delivery record](../delivery-verification.md)
and [future deployment requirements](../deployment-readiness.md) cover the local
product and its limits. [Presentation assets](../demo-script.md) include six real
desktop/mobile/disconnected/recovered screenshots, a native 53.32-second WebM,
seven English caption cues and capture metadata. Only fictional demo identities
and content are published; credentials were entered before recording. Raw traces
and environment files are not part of this public media package.

The embedded video on the current GitHub `main` README was replayed in Chromium
to `ended` at 53.32 seconds, without a media error. README links point to the
script and delivery/deployment documentation. The tracked environment files are
templates; populated `.env` and `.env.demo` remain ignored. No new media, fixtures,
dependencies or application changes are needed for this audit.

One local API and PostgreSQL are supported. Events are best-effort; idempotent
persistence and bounded recovery do not imply exactly-once delivery or durable
offline sending. Read/unread state, typing/presence and capacity measurements are
stage 6 work. Physical devices, other browser engines, full screen-reader/native
keyboard audits, load, multiple API instances, remote TLS and backup/restore are
not certified here. No deployment or public application URL is required.

## Verification outcome

**Verdict: A01–A18 verified for the stated local P0 scope. CP0-C and CP1-C
are explicitly verified by this review; CP5-B meets its exit criteria.** Owner
review and manual merge of this checkpoint's PR remain required. The accepted
source is identified by its Git SHA; package metadata remains `0.0.0`. No release
tag or public deployment is implied by functional portfolio acceptance.

[Integrated CI 39415272879](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39415272879)
passed on the exact `3d99c49` baseline: **53 API, 103 Angular, 3 contract,
7 demo-reset guard and 5 Docker tests; 23 PostgreSQL integration results in
each order; 29 Chromium E2Es and 6 usability repetitions**. The audit reported
zero vulnerabilities at that execution. The configured suites passed without
skipped/TODO cases or E2E retries. Stack teardown, demo cleanup verification and
artifact publication succeeded. These are observed run results, not a promise
that future dependencies or environments will have the same outcome.

The independent source/assertion audit and parent trace found no missing A01–A18
case. Documentation corrections distinguish composite recovery evidence,
historical local runs and actual protected checks. Local documentation links
and whitespace have been checked. Final diff review and CI against the final
documentation head must pass before the checkpoint PR is made ready.
Product code, schema, Compose, workflow, dependencies,
existing assertions and test thresholds are unchanged.

[Checkpoint PR #59](https://github.com/MatteoMurcia/real-time-chat/pull/59) records final branch CI and owner-review status. Independent final diff review and parent review completed with no Required findings remaining.
