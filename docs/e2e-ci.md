# Critical E2E in CI — 4.3b

The Containers job builds the complete Compose app, applies migrations to a fresh
database and runs Chromium through Nginx. It uses only generated database
credentials and synthetic accounts. Playwright supplies a fresh context per test;
explicit extra contexts represent additional clients/sessions and close in `finally`.
The shared `chatAccount` fixture creates real accounts/channels through HTTP and
closes its Socket.IO sender even on failure. No shared saved login state is used.

## Running and diagnosing

Follow the isolated stack setup in [the README](../README.md#continuous-integration).
Run `npm run test:e2e`; the full suite has one worker, no retries and `forbidOnly`
in CI. No test is ignored to obtain a pass. An assertion failure fails Containers.

- Full-suite HTML: `playwright-report/critical/index.html`.
- Full-suite test output: `test-results/critical/`.
- CI's three keyboard/responsive repetitions: `playwright-report/usability/` and
  `test-results/usability/`, so the second invocation cannot erase the first.
- Every run produces HTML. Only failed tests retain their trace and automatic
  screenshot. Existing explicit usability screenshots remain available.
- Download `e2e-diagnostics-<run>-<attempt>` from the run's artifacts and extract it.
  Use `npx playwright show-report playwright-report/critical` for the report, or
  `npx playwright show-trace <path-to-trace.zip>` for actions/network/DOM details.
  Use the pinned workspace Playwright installation. Do not upload traces elsewhere.

The workflow publishes reports/traces and usability PNGs only after successful
`docker compose down --volumes --remove-orphans`. If cleanup fails, the job fails
and diagnostic uploads are withheld. Retention is seven days. Traces exclude
source embedding, but **are not redacted**: they can contain synthetic passwords,
cookies, CSRF tokens and message bodies. They are suitable only for this disposable
stack, whose database and sessions have been deleted before publication. Local
runs retain their test volume: treat their artifacts as credentials until that
isolated volume is removed. Do not run this suite against real user data.

This uses Playwright's [HTML reporter](https://playwright.dev/docs/test-reporters#html-reporter)
and [failure trace configuration](https://playwright.dev/docs/api/class-testoptions#test-options-trace).
Its recorder also captures manually created contexts; a tracing wrapper is unnecessary.

## Acceptance evidence

Tests below run in the existing Quality, Integration or Containers jobs. Integration
runs all scenarios forward and reverse against separate fresh databases. Browser
evidence is distinguished from unit/integration coverage rather than relabelled.

| Criterion | Concrete evidence |
| --- | --- |
| A01 | `register.spec.ts`, `session.spec.ts`: register/login/reload/logout, revoked cookie and independent session. |
| A02 | `subscriptions.spec.ts`: authenticated outsider cannot subscribe/send/read history; forged membership rejected. |
| A03 | `message-order.spec.ts`: ten concurrent same-key sends return the identical canonical acknowledgement, one history item and one visible row. `integration/messages.ts` also checks one receiver event and one created row. |
| A04 | `message-order.spec.ts`: changed body conflicts without a second row. `integration/messages.ts` and `message-idempotency.ts`: changed channel and concurrent conflicting bodies/keys, exact row counts and sequence counters. |
| A05 | `message-retry.spec.ts`: real committed send with acknowledgement held/lost, automatic/manual retry keeps its original key. `integration/messages.ts` loses the real gateway acknowledgement after commit and confirms one publication/row. |
| A06 | `message-order.spec.ts`: hold both real frames, release event→ack and ack→event; each first frame clears pending, exact second-frame receipt leaves one canonical row. HTTP recovery is disabled and empty initial history awaited. Reducer tests add timeout permutations. |
| A07 | `reconnect.spec.ts`: offline receiver, 105 messages, API restart, three fixed-H pages, exact ordered IDs and retained draft. |
| A08 | `integration/commit-emission.ts`: committed row without publication, same connected receiver, recovered over HTTP. `sync-gap.spec.ts`: suppressed live frames, fixed-H multi-page UI recovery triggered by focus. Angular store's 15-second test separately proves periodic recovery without focus. |
| A09 | `integration/message-sync-races.ts`: real delayed writer, sync and concurrent sender observed waiting in PostgreSQL, commit and rollback. Either lock order recovers the exact complete interval; BIGINT boundaries remain exact. |
| A10 | `channel-races.spec.ts`: events around initial snapshot, stale A/B responses after returning to A, recovery cursor remains valid. |
| A11 | `integration/subscriptions.ts`: real-lock/local-queue barriers enforce subscribe/leave and send/leave in both orders. Send-first writes once; leave-first rejects without a write. |
| A12 | `integration/socket-session.ts`: real idle expiry and revocation races, other session survives. `session-revocation.spec.ts`: tabs, offline reconnect, cleared UI and independent valid session. |
| A13 | HTTP integration and `subscriptions.spec.ts`: hostile origins and missing/foreign CSRF rejected. `conversation.spec.ts`: hostile HTML remains literal before/after reload, no active descendants or execution marker. |
| A15 | `history-scroll.spec.ts`: 1280/390px anchor within 2px across pagination, errors, live traffic and held responses. |
| A16 | `keyboard.spec.ts`, `responsive.spec.ts`: keyboard/composition/focus, six widths, reduced height, twenty channel changes and listener cleanup; each repeated three times in CI. |

A14 remains CP4-C; A17–A18 remain CP5-B. Partial restart/persistence checks do
not close those checkpoints. CP0-C and CP1-C also remain pending.

## Verification record

[CI 39212749055](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39212749055)
on `f4c7843` passed Quality and both integration orders, then failed Containers
with exit 1. The deliberate assertion in `security-headers.spec.ts` failed as
intended; it also exposed a test-observer defect in the new message-order case
(22 passed, two failed). Both failures retained diagnostics. Repetitions were
skipped, but teardown and both artifact uploads succeeded.

The parent downloaded and inspected
[the failure artifact](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39212749055/artifacts/12167574670).
Its HTML report and two failed-test trace/screenshot pairs were intact. The
controlled-failure trace contains the exact assertion error, 86 actions, eight
DOM snapshots and three network streams; no embedded source resources were found.
The failure screenshot shows the actual sign-in page. The ordinary report can
include Playwright's error-context attachment; this does not make traces redacted.

The observer subclass had watched Playwright's native upstream socket before
routing, so held server frames could appear received and a released frame could
be missed. A disposable local WebSocket reproduction confirmed that behavior.
`ade51b6` observes dispatched page-side message events instead: the same
reproduction sees no held frame and observes both released frames in their exact
order. This instrumentation is test-only. `85082b9` removes the deliberate failing
assertion; no production behavior or deadline was changed.

[CI 39213600128](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39213600128)
on `85082b9` passed all three jobs: **45 API, 103 Angular, three contracts, five
Docker checks, 21 integration results in each order, 24 Chromium E2Es and six
repeated usability executions**. E2E took 1.6 minutes and repetitions 30.6 seconds.
There were no skipped/flaky tests or retries; audit found zero vulnerabilities.
Both database-cleanup checks, stack teardown and uploads passed.

The parent downloaded
[the successful diagnostic artifact](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39213600128/artifacts/12168422840)
and decoded both HTML report manifests: critical retained 24/24 passing results,
usability retained 6/6, each with zero unexpected/flaky/skipped results. This
confirms the repeat invocation preserved the first report. Only failed tests
retain traces; the successful artifact contains the reports, not success traces.
The separate [usability artifact](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39213600128/artifacts/12169185233)
was also uploaded. All artifacts expire after seven days.

Independent review and parent review covered the final code, failure diagnostics,
observer reproduction, acceptance map and successful CI evidence. No required
findings remain. PR #49 is left for owner review/manual merge. No app behavior,
API/schema, package dependencies, primary environment/data or deployment changed.
Local lint/types, unit tests and build passed; Docker-dependent local execution
could not complete because its engine was unavailable, so real-stack evidence is
from Linux CI. Coverage is Chromium with synthetic data; it does not certify
other engines, physical devices or production workloads.
