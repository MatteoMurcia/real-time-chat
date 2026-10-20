# CP5-A — Tryable demo and independent Docker startup

Reviewed on **2026-10-20** against integrated `origin/main`
`9cf0387a2aca0e4af30c7fcc98b72001e6f577ce` (5.2a merged by PR #55).
Scope: demo access/maintenance, independently reproduced local startup, and
accurate README guarantees. No runtime, schema, dependency or test policy changes.

**Verdict: verified for this scope.** Independent source/documentation audit and
parent reproduction found no behavior blocker. Stale present-tense status notes
were corrected. Owner review/manual merge remains required. CP0-C/CP1-C remain
pending; presentation, final delivery and CP5-B are separate.

## Acceptance and evidence map

| Criterion | Evidence and observed result |
| --- | --- |
| An evaluator can enter the demo | Overview visibly explains Alice/Bob, private window/other browser, Demo Lounge, sign-in link and shared-data/reset warning. Passwords come from local operator configuration, not the UI/bundle. [Guide](../demo.md), [overview](../../apps/web/src/app/features/overview/overview.html). |
| Fictional accounts and paginatable history | Seed ran twice in a fresh dedicated database: 2 users, 0 sessions, 2 channels, 4 memberships, 111 messages. No duplicates. Lounge initially showed 50 rows; after two real sends and earlier-page loads it contained 107 distinct canonical IDs. Planning settled at six rows. [Seed](../../apps/api/prisma/demo-seed.ts), [seed tests](../../apps/api/test/integration/demo-seed.ts). |
| Two independent sessions converse | Parent used two separate browser contexts, authenticated Alice and Bob, sent once from each, and observed cross-session delivery and confirmed saved rows. Database had two sessions; no shared-cookie tab substitution. [Browser regression](../../e2e/demo-maintenance.spec.ts). |
| Independent startup is reproduced | New GitHub `main` clone at the audited SHA, fresh named demo volume, empty migrated tables, successful image/tool builds and both public health endpoints returning 200. No host app dependencies/generated output. Details below; [ordinary-stack walkthrough](../installation-verification.md) is complementary earlier evidence. |
| Maintenance remains explicit and isolated | Parent followed stop API/web → confirmed reset → seed → restart. Both old browser sessions returned to login without a conversation. Counts returned to `2/0/2/4/111`; new Alice login restored the 50-row seeded view with neither test message. [Reset procedure](../demo.md#reset-manually), [guard tests](../../scripts/reset-demo.test.mjs). |
| README does not promise offline-first | It explicitly rules out a durable offline queue/offline-first and warns that view-local drafts/pending sends can disappear on reload. [README](../../README.md#architecture-and-guarantees), [client state](../../apps/web/src/app/features/chat/chat.store.ts). |
| README does not promise exactly-once delivery | It separates idempotent persistence from best-effort events and acknowledges a commit/ack/emission gap. [ADR-004](../decisions/004-message-guarantees.md), [suppressed-emission integration](../../apps/api/test/integration/commit-emission.ts), [browser gap recovery](../../e2e/sync-gap.spec.ts). |

## Fresh merged-baseline reproduction

The parent cloned GitHub `main` into a new temporary checkout, separate from
5.2a's checkout and the working tree. The SHA was checked before execution.
Before and after application startup it had no `node_modules`, generated Prisma
client or web build output on the host; tracked files stayed clean.

The flow followed [the demo guide](../demo.md), copying `.env.demo.example` to
ignored `.env.demo` and generating three separate local-only passwords. Isolation
substitutions were project `cp5a-check-c3fc988f`, web port/origin
`18086` / `http://127.0.0.1:18086`, subnet `172.29.45.0/24` and proxy
`172.29.45.254`. Every Compose invocation selected the project, environment and
both base/demo files explicitly. No pre-existing volume belonged to that project.

Docker Engine 29.8.2 ran Linux containers. The host supplied Git, Docker/Compose
and environment-file preparation; no host npm/Node/PostgreSQL command built,
migrated, seeded or ran the app. BuildKit could reuse matching image layers;
this is not a cold-cache or physical clean-machine benchmark.

Startup/database observations:

- Database/API/web healthy; migration job exited zero. Only the web port was
  published, on `127.0.0.1`; API/database had no published ports.
- Three completed migrations, no incomplete/rolled-back migration records.
- Before seed, User/Session/Channel/Membership/Message counts: `0/0/0/0/0`.
- Actual target: `chat_demo`, role `demo_local`, marker
  `real-time-chat:local-demo:v1`.
- `/api/health/live`: 200 `{"status":"ok"}`;
  `/api/health/ready`: 200 `{"status":"ready"}`.

After seed and both logins/sends, counts were `2/2/2/4/113`: the original 111
messages plus the two confirmed test sends. Earlier-page checks waited for the
selected channel and its settled rows, rather than sampling the previous view
while channel selection was pending. Reset removed those sessions/messages;
reseed restored 111 messages before the subsequent fresh Alice login.

This is an agent-operated browser check, not a human usability study. The
previous 5.1b interactive first-message measurement remains **14.644 seconds**,
separate from its **907 ms** scripted E2E measurement; neither is re-labelled as a
new benchmark here. CP5-A independently repeats the usable flow on merged main.

Both browser contexts were closed. Before destructive test cleanup, the actual
database mount and Compose volume-owner label were checked against this generated
project. Only its containers/networks/volume and `.env.demo` credential file were
removed. Ordinary `.env` and development data were not reset. Volume deletion was
disposable test cleanup; normal documented shutdown remains `down` without
`--volumes`.

## Audit findings and regression evidence

The independent reviewer inspected README, architecture/ADRs, demo configuration,
seed/reset implementation and linked browser/integration tests. The parent
reviewed those findings and reproduced the flow above. No Critical or Required
behavior finding remained. Corrected documentation:

- Demo notes no longer describe merged 5.2a/PR #55 as pending.
- The installation record identifies PR #55 as merged; the plan does likewise.
- Seed verification explicitly dates its historical unavailable-Docker result
  and links later local access/reset/installation evidence.

[Integrated baseline CI 39323797423](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39323797423)
passed Quality, Integration and Containers on `9cf0387`: 53 API, 103 Angular,
three contract, seven reset-guard and five Docker checks; 23 integration results
in each order; 29 Chromium E2Es and six usability repetitions. The existing demo
E2E checks unsafe reset refusal, old cookie/channel rejection and an unrelated
stack canary; the parent did not claim to re-run every negative case manually.
The [checkpoint PR](https://github.com/MatteoMurcia/real-time-chat/pull/56) tracks
the additional final-branch CI checks. No checks,
assertions, thresholds or retries were weakened to pass this audit.

## Remaining gates

The independent startup evidence supports A17; final A01–A18 acceptance remains
CP5-B. This checkpoint does not certify the broader A18/final delivery smoke in
5.3a, create a video/screenshots package for 5.2b, or close CP0-C/CP1-C. There is
no deployment, load/multi-instance claim, physical-device test or new Watch/host
toolchain verification. The next planned task is **5.2b — Capture visual evidence
and a demo script**.
