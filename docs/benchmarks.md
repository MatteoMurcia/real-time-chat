# Reproducible local Socket.IO load

This measures a bounded workload against one API process and PostgreSQL through
real authenticated Socket.IO connections. It establishes an observed local
baseline, **not maximum capacity, a production sizing recommendation or an SLA**.
There is no application optimization or tuning in this task.

## Run the same scenario

Use the repository's Node/npm versions, install dependencies with `npm ci`, and
start Docker with Linux containers and a local Unix-socket or named-pipe context.
From the repository root, run twice, sequentially:

```sh
npm run benchmark
npm run benchmark
```

The runner builds the existing runtime/migration images and a small load-tool
target using the installed `socket.io-client`. No extra dependency is added.
It creates the fixed `chat-benchmark` Compose project with a dedicated database,
role, random password, internal network and fresh named PostgreSQL volume.
No ports are published, Docker socket is not mounted into the generator, and
there is no target URL option. The worker's configured workload target is fixed
to `http://api:3000` on this isolated network; its allowed Origin header is
`http://localhost:8080`. The worker shares that network with the database but
is not given its password.

An existing project container, network or volume causes refusal before creation.
A temporary host lock prevents concurrent runner invocations. `DOCKER_HOST`
overrides and TCP/SSH Docker contexts are refused; the verified local context is
pinned for subsequent commands. This protects the normal application/demo data.
Only resources created by this invocation are torn down in `finally`, including
the exclusive benchmark volume. Interruptions are handled; SIGKILL, machine loss
or Docker failure can leave resources or the lock behind. Inspect those before
manual removal; never point cleanup at the normal application project.

Invocations which acquire the lock write a new JSON file under
`docs/benchmark-results/` for setup/measurement successes and failures, assuming
the output write succeeds. Invalid arguments and lock acquisition failures stop
earlier without a report. Existing result files are never overwritten.
Failure reports retain fixed host reason codes and bounded worker stage/HTTP
diagnostics, without passwords, cookies, session tokens or actual message bodies.
Do not remove a stale temporary `real-time-chat-benchmark.lock` while a run is
active. Inherited non-benchmark containers are not stopped or removed.

## Parameters and workload

```sh
npm run benchmark -- --users 8 --connections 2 --rate 1 --seconds 30 --warmup 5
```

| Parameter | Meaning | Default | Bound |
| --- | --- | --- | --- |
| `users` | Separate registered users and authenticated sessions | 8 | 1–50 |
| `connections` | Subscribed WebSockets per user/session | 2 | 1–5; at most 100 total |
| `rate` | Scheduled messages per second **per connection** | 1 | 0.1–3 |
| `seconds` | Measurement send window | 30 | 5–120; at least one slot per connection |
| `warmup` | Separate warm-up send window | 5 | 0–30 |

All users join one channel. Each message has a new UUID and a 128-byte ASCII
body, with no application retry. This deliberately exercises one hot channel's
transactional serialization, session revalidation and fanout. The default has
16 connections, 80 warm-up messages and 480 measured messages. Each successful
message should reach all 16 subscribers; 560 committed messages imply 8,960
warm-up-plus-measurement deliveries. There is no pre-existing application data.
Setup registers/logs in users sequentially through the real HTTP/CSRF endpoints,
then opens and acknowledges each channel subscription before warm-up begins.
Auth/setup duration is excluded from message latency measurements.

The send quota remains **30 attempts/10 seconds per user** and the session limit
remains five connections. Only registration/login/channel fixture quotas are
raised to 1,000 in the dedicated Compose file. Many connections of one user
share its message quota; a rejected load is not evidence of server saturation.
For example, `--users 1 --connections 3 --rate 3 --seconds 5 --warmup 0`
intentionally exceeds that quota. A failed report and nonzero exit are expected;
inspect `measurement.errors` rather than treating rejection latency as capacity.

## What the measurements mean

- The generator follows a monotonic-clock schedule, spreading connections across
  the aggregate interval. It does not wait for the previous ACK to offer the next
  slot. A slot more than one aggregate interval late, or a connection with two
  outstanding sends, is skipped and reported instead of replayed in a burst.
- `planned`, `sent`, `skipped` and dispatch-lag p95 expose generator limitations.
  `errorRate` counts rejected/timed-out/invalid ACKs divided by sent requests;
  `unsuccessfulScheduledRate` also includes slots that were never offered.
- ACK p50/p95 use nearest rank on **successful validated ACKs only**, in
  milliseconds. Raw ACK samples remain in JSON. Empty successful samples produce
  null percentiles. Latency is observed client round trip through validation,
  not database service time or browser rendering time.
- Each window waits for its send deadline and outstanding ACKs (five-second
  per-request timeout). Throughput divides counts by the observed window-plus-
  drain elapsed time. The warm-up summary is separate; delivery and final dataset
  checks include both windows.
- Canonical ACK fields are validated; SHA-256 fingerprints of all public message
  fields compare each event with its ACK, even if the event arrives first.
  Missing, extra, duplicate, malformed or mismatched broadcasts fail verification.
  Final PostgreSQL user/session/channel/message counts are checked. Timed-out
  sends are not retried or assumed unsaved; an extra persisted row fails the
  final count check and remains visible in the artifact.
- Host-side `docker stats --no-stream` samples API and database CPU, memory,
  network, block I/O and PIDs. A call plus a one-second pause gives a coarse
  sampling interval, not a continuous profiler. Filter timestamps to the worker's
  measurement window; warm-up/setup samples remain available separately. At least
  one measured sample and no sampling errors are required. The local host and VM
  clocks are assumed synchronized for that coarse selection.
- Linux Docker CLI memory excludes inactive file cache; it is not process RSS.
  CPU percentages are Docker's unnormalized values and can exceed 100% across
  cores. Network/block I/O are cumulative observations, not phase-only rates.
  See [Docker stats semantics](https://docs.docker.com/reference/cli/docker/container/stats/)
  and [runtime metrics](https://docs.docker.com/engine/containers/runmetrics/).
  Generator CPU covers the measured window plus ACK drain; its peak RSS is for
  the worker's entire lifetime, including setup/warm-up.

Reports include host CPU/OS/RAM, Docker VM resources, Node/npm/Compose/PostgreSQL
versions, declared API dependencies, image IDs, source commit and dirty-source
flag, parameters, dataset counts and resource samples. Raw results are evidence
for that recorded environment, not portable thresholds. The runner exits nonzero
for errors, skipped slots, protocol/dataset failures, missing resource evidence,
or failed cleanup; the JSON still records the observation.

## Recorded runs

The retained pair below uses identical parameters and a fresh volume for each
run. Hardware, measurements and resource observations are taken from those JSON
files; the interpretation is limited to that workload.

Measured on 2026-10-21, clean harness source `5f9eb91390ab3f677038f1c7a9cf561a9b2030b1`.
Host: AMD Ryzen 9 5900HS with Radeon Graphics, 16 logical CPUs,
15.41 GiB RAM, Windows kernel 10.0.26300. Docker Engine 29.8.2 on
Docker Desktop/WSL2 (6.18.33.2-microsoft-standard-WSL2) exposed 16 CPUs and
7.46 GiB to Linux containers; Compose 5.6.0.
Both runs recorded **13 other running containers**, so this was not an idle host.
API/generator Node v24.21.0, npm 12.1.0, PostgreSQL 18.6,
NestJS 12.1.2, Socket.IO 4.8.3, Prisma 7.10.0.

| Metric | Run 1 | Run 2 |
| --- | --- | --- |
| Raw JSON | [1](benchmark-results/2026-10-21T17-16-19.001Z-acdb641e.json) | [2](benchmark-results/2026-10-21T17-17-19.093Z-4f5a8486.json) |
| Measured ACKs | 480 | 480 |
| ACK p50 / p95 (ms) | 10.25 / 12.65 | 10.27 / 13.27 |
| Acknowledged messages/s | 16.00 | 16.00 |
| ACK error rate / skipped slots | 0% / 0 | 0% / 0 |
| Committed messages / verified deliveries | 560 / 8960 | 560 / 8960 |
| Measured resource samples | 11 | 11 |
| API max sampled CPU / memory (MiB) | 21.97% / 315.80 | 28.38% / 298.60 |
| PostgreSQL max sampled CPU / memory (MiB) | 9.93% / 45.72 | 10.26% / 46.45 |

Both runs had zero missing, extra, malformed, mismatched or duplicate deliveries,
zero disconnects and successful teardown. The sampled maxima are not continuous
peaks or resource reservations. Five warm-up seconds preceded each thirty-second
measurement on a fresh volume. These observations support the offered **16
messages/s** scenario only; they do not establish where saturation begins.

Quota-control [raw result](benchmark-results/2026-10-21T17-19-57.078Z-24e1432e.json): 1 user, 3 connections,
3 messages/s per connection for 5 seconds, no warm-up. It offered **45** sends,
received **30** successful ACKs and **15 RATE_LIMITED** responses (33.33% ACK
error rate), with zero skipped slots and all 90 successful deliveries verified.
The runner correctly returned nonzero/status `failed`, while dataset/delivery
checks and teardown passed. This confirms quota/error reporting, not an
application throughput ceiling. Its cold, shorter latency sample is not compared
with the warmed baseline pair.

## Limits and verification

This is direct WebSocket traffic inside Docker, without Nginx, TLS, browser UI,
history/recovery requests, typing/presence polling, session churn or external
network delay. PostgreSQL uses its image's default durability settings and a
dedicated Docker volume; the host's underlying storage is not independently
calibrated. There are no container CPU/RAM caps beyond Docker's VM budget.
The generator, API and database share that machine, with any other running
containers recorded as a count. Background contention, thermal state, Docker
Desktop virtualization and generator validation can affect results. Two short
runs provide neither confidence intervals nor a saturation/leak/soak test.
No replica or remote-production capacity is inferred, and no hardware-independent
latency threshold is added to CI.

[Native harness tests](../scripts/load-test.test.mjs) cover configuration limits,
local Docker transports, percentile calculations, scheduling/error denominators,
extra/missing delivery and malformed or mismatched payloads. `npm test` includes
them through the existing script-test glob. Runtime behavior is checked with
real Docker runs; final Quality, Integration and Containers CI is linked from
[PR #67](https://github.com/MatteoMurcia/real-time-chat/pull/67). The [implementation plan](../tasks/plan.md) records incremental
commits, development checks, retained evidence and the separate CP6-C status.
