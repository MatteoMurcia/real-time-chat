# CP6-C — Final local delivery with stage 6 additions

Reviewed on **2026-10-22** against integrated `main`
`1ab90c041371bbbcb16e66c411049a243c215b9a`, after the owner merged the
load-measurement task through [PR #67](https://github.com/MatteoMurcia/real-time-chat/pull/67).
This checkpoint checks the completed additions and the compiled local Compose
delivery. It does not add another feature, publish images or deploy the app.

## Completion and evidence

| Addition | Implemented scope | Evidence and retained limits |
| --- | --- | --- |
| 6.1a / 6.1b — Read state | Monotonic per-user/channel cursor, private unread counts across sessions, only other people's messages counted | [CP6-A](cp6-a.md), [read contract](../read-cursors.md), [independent-session repair](../../e2e/read-consistency.spec.ts), [unread browser scenario](../../e2e/unread.spec.ts). A reached sequence prefix is not proof of human attention. |
| 6.2a — Typing | Authorized volatile hints, per-connection renewal, per-user display, five-second receiver expiry | [Typing contract](../typing.md), [integration](../../apps/api/test/integration/typing.ts), [browser scenario](../../e2e/typing.spec.ts). No draft sharing, durable activity or guaranteed delivery. |
| 6.3a / 6.3b — Presence | Valid connection aggregation, shared-member snapshots and accessible online/offline/unknown labels | [CP6-B](cp6-b.md), [presence contract](../presence.md), [multi-tab browser scenario](../../e2e/presence.spec.ts), [lost-hint repair](../../e2e/presence-repair.spec.ts). One API, bounded requested authors and heartbeat-based silent-loss detection. |
| 6.4a — Local measurement | Configurable isolated workload, validated ACKs/fanout/dataset, sampled resources and repeatable retained runs | [Methodology and three raw results](../benchmarks.md#recorded-runs), [harness tests](../../scripts/load-test.test.mjs). Two 8-user/16-connection runs at 16 messages/s, zero errors/skips, p95 12.65/13.27 ms; separate expected quota failure. Not maximum capacity or an SLA. |

Every listed stage 6 task is implemented. CP6-A and CP6-B retain their original
review dates and scope; their historical “next task” notes are not current
backlog statements. The canonical current status is in the
[implementation plan](../../tasks/plan.md). P0's [A01–A18 review](cp5-b.md)
remains evidence for the original delivery, rather than a claim that it tested
the later activity additions.

## Local image and Compose verification

The checkpoint uses base `compose.yaml`, with an explicit disposable environment
and the exclusive `handshake-verification` project, database/role `cp6c_qa`,
loopback port/origin 18094, separate subnet and fresh PostgreSQL volume. The
project was checked for pre-existing containers, networks and volumes before
creation. No runtime bind mount or application change is introduced.

The verification sequence is `config --quiet`, `up --build --wait`, an empty
user-table check, tools-profile seed build and two seed executions, public
health verification, and the full existing Chromium suite. Browser tests use
one worker and zero retries, with the explicit disposable URL/project/env file.
The persistence scenario recreates the compiled stack while retaining its
volume; assertions verify accounts, the old session cookie, read cursor,
message identity and idempotency after recreation. Other scenarios cover real
API restart/recovery, two-user conversation, membership authorization, unread
state, typing and presence, including repair after lost invalidations.

Both Dockerfiles include Linux test/build stages; this local invocation reused
the cached API test/build layer while the web stage executed 138 tests.
Container inspection
checks the running API/web image IDs and non-root users. Host Playwright drives
the browser; application runtime, migrations, seed and database run in Docker.
This is a fresh-volume image rebuild from the integrated source in the current
checkout, not a second independent clone or a claim that the host has no Node.

## Recorded execution

The full local Chromium suite passed **36/36** in **5.7 minutes**, with one
worker and zero retries. Startup reported zero users before fixtures; the seed
reported the same two accounts, two channels and 111 sample messages on both
runs. API/web/database were healthy, migration exited zero, and the public
health response was `{"status":"ok"}`. API and web ran as `node` and `nginx`.

The initial compiled images inspected were:

- API: `sha256:d3d17822c238c19439807ea93ef47590254b737970772afd83d50b5287ece068`
- Web: `sha256:7358f467f1ae087ef8222349f4d557b027d2df5f69495e4a5f2ba873221610c1`
- PostgreSQL: `sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c`

The stack, network and volume were removed in `finally`; label-based checks
found no checkpoint resources remaining, and the temporary environment file
was deleted. The ordinary `.env`, database volume and thirteen unrelated
running containers were preserved. No trace/session artifact is committed.

The integrated baseline's [CI run 39732712887](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39732712887)
passed Quality and Integration but failed two of 36 browser scenarios. This is
recorded as a failure, separately from the successful local run. Trace review
found two test setup gaps, addressed without changing the application:

- The demo failure capture showed an empty email and validation error, with no
  login request from that page. Route autofocus racing the first fill is the
  likely cause, inferred from the trace and the existing render callback. The
  helper now waits for the existing heading focus before filling credentials.
- The presence test toggled browser offline mode without proving that the
  WebSocket disconnected. The trace had no new handshake; a timed-out query's
  ten-second error retry collided with the ten-second assertion. The test now
  closes the actual reader WebSocket and observes the interrupted state before
  restoring the network, matching the existing recovery test mechanism.

Assertions, timeouts, quotas and retries are retained. The focused demo/presence
block passed **9/9**, including three demo repetitions after the autofocus guard.
That process started before the presence edit, so it is not counted as proof
of the final presence repair. A fresh process then ran the final explicit-disconnection presence scenario
**3/3** in **53.4 seconds**. Both runs completed teardown and credential removal.
Lint passed without warnings. Application sources, contracts, schema, image
definitions, Compose and dependencies are unchanged from the integrated base.

Independent review and primary review checked the evidence and the test setup
repairs. The global plan summary now records all stage 6 merges, rather than
claiming 6.3a/6.3b are still pending. The checkpoint's
[PR #68](https://github.com/MatteoMurcia/real-time-chat/pull/68) is the record for
Quality, Integration and Containers on its exact final head. Those checks were
pending at the time of this local review; their final status is reported in the
PR, and only completed successful checks count as passing.
That CI is separate from the local checks above and
from the failed integrated-baseline run. The owner reviews and merges manually.

**Verdict: CP6-C verified locally for the documented single-instance scope.**
All planned stage 6 additions are implemented; this checkpoint remains subject
to final-head CI and owner review in its PR. It is not yet merged by this review.

## Documentation and limits

README now identifies the completed P0 delivery and stage 6 additions, links the
activity contracts and bounded measurements, and removes the stale statement
that presentation/final delivery were still pending. Existing screenshots/video
are historical P0 evidence; they are not presented as captures of every later
activity feature. Current presence screenshots are exercised by its browser
scenario, without replacing the historical presentation assets.

No new benchmark was needed for this checkpoint: the two retained measured
runs remain attributed to harness commit `5f9eb91390ab3f677038f1c7a9cf561a9b2030b1`.
The later validation guards do not change their default workload. Local Compose
and browser correctness checks are separate evidence, not new latency samples.

The supported target remains one local API instance and Chromium. Remote
hosting, registry publication, release tagging, multiple API instances, TLS,
saturation/soak testing, exact unread-count load characterization, other browser
engines, physical devices and an exhaustive accessibility audit are not certified.
Presence/typing remain best-effort with the membership/heartbeat limitations in
CP6-B. These are explicit limits, not incomplete stage 6 tasks or production
readiness claims. Owner review and merge remain manual.
