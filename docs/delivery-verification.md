# Reproducible local delivery — 5.3a

Verified on **2026-10-20** against GitHub `main` commit
`51eb848cbad944b1e75585b28e7b27d8fcd26455` (merged PR #57). The application,
Dockerfiles and Compose files are unchanged by this documentation task.
This is the tested source version; package metadata remains `0.0.0` and no
release tag is published here. CP5-B is the separate final acceptance review.

## Clean source and environment

A new single-branch clone was fetched from GitHub and its SHA checked before
execution. It was separate from the developer checkout and prior installation
checks. No host dependency install, application build, Prisma generation,
migration, seed or PostgreSQL process was used to run this installation.
The clone remained clean and had no host `node_modules`, generated Prisma client
(`apps/api/src/generated`), API/web output or built contracts afterward.

Host: Windows, Docker Desktop Linux engine **29.8.2**, Compose **5.6.0**.
The host supplied Git, Docker and environment preparation. A separate browser QA
driver used the developer checkout's existing Node/Playwright/Socket.IO tooling;
it did not install dependencies into, build or serve the clean clone. Thus this
is an automated, agent-operated browser smoke, not a human usability study or
proof of a brand-new physical machine. Docker builds could reuse cached layers.

Following the [demo guide](demo.md), `.env.demo.example` was copied to an ignored
`.env.demo` with three independent random local-only passwords. The test selected
project `delivery-check-d4c1d522`, port/origin `18089` /
`http://127.0.0.1:18089`, subnet `172.29.47.0/24` and proxy `172.29.47.254`.
It used a fresh `<project>_demo_postgres_data` volume. Every Compose command
specified the project, environment, base file and demo override explicitly.
The ordinary checkout environment and development volume were preserved.

## Startup and seed

The documented sequence was configuration validation → `up --build --wait` →
build seed tool → run seed twice. Database observations were taken before seed.

| Check | Result |
| --- | --- |
| Compose and migration gate | DB/API/web healthy; migration exited zero; three completed migrations and zero incomplete/rolled-back records |
| Actual database identity | `chat_demo`, role `demo_local`, marker `real-time-chat:local-demo:v1` |
| User/Session/Channel/Membership/Message before seed | `0/0/0/0/0` |
| Same counts after two seed executions | `2/0/2/4/111`; no added seed duplicates |
| Public health | `/api/health/live` → 200 `{"status":"ok"}`; `/api/health/ready` → 200 `{"status":"ready"}` |
| Network exposure | Only web published, `127.0.0.1:18089`; API/DB had no host port bindings |
| Runtime processes | API user `node` / UID 1000; web user `nginx` / UID 101 |
| Container toolchain | Node 24.21.0, npm 12.1.0, PostgreSQL 18.6 |

The built runtime image IDs were
`sha256:2b758ddb007712e328039f92257fb914e849a73671049be38df005a712b98cbf`
(API) and
`sha256:54a673bb3a41031a33d827a133dfa48ed06f9caf5b97764b858da9916c15f5cb`
(web). These identify this local run; version-tagged base images and OS package
downloads do not promise identical future image bytes.

## Two-user authorization and recovery smoke

Alice and Bob signed in through the UI in independent Chromium contexts.
An unauthenticated context received 401 listing channels. Bob left Demo Planning
through the UI. While he was a nonmember:

- History and cursor sync returned HTTP 403.
- A real authenticated Socket.IO connection received `FORBIDDEN` for channel
  subscription and message send; the attempted message was not persisted.
- Rejoining through the UI restored access to the six seeded messages.

Alice and Bob then exchanged one confirmed message each, visible across sessions:
the channel had eight canonical rows. Alice alone went offline and her routed
WebSocket closed. Sending was disabled; she typed an unsent draft. While she was
offline the API was restarted through Compose, with its normal shutdown grace.
Its start time changed, Bob reconnected and the API returned to healthy. Bob sent
two more messages while Alice still showed eight rows.

On restoring Alice's network, HTTP sync returned 200 with both missed messages
and two overlapping messages already received live. The UI contained **ten
distinct canonical IDs**, preserving the previous eight IDs/order and the draft.
Alice manually sent that draft; both contexts saw it confirmed, for eleven rows.
No duplicate saved row or uncaught browser page error was observed.

The first QA attempt incorrectly expected exactly two HTTP response items and
stopped on the four-item overlap. The client's sync cursor advances on completed
HTTP recovery, independently of live event delivery; overlap is valid. The
verifier was corrected to check the missing bodies, allow only known overlap,
and assert unique UI IDs/order. The disposable demo was reset/reseeded before the
complete successful rerun. Product code, existing tests and thresholds did not
change. [Recovery regression](../e2e/reconnect.spec.ts) also covers a larger gap.

## Full recreation and persistence

After the eleven-message conversation, the test recorded the five database
counts, a digest of all saved message rows, selected-channel IDs and the actual
database volume name. It ran normal `down` **without `--volumes`**, followed by
`up --build --wait` with the same project/environment/files.

| Before/after comparison | Observed result |
| --- | --- |
| User/Session/Channel/Membership/Message | `2/2/2/4/116` before and after |
| Database volume | Same named volume; DB/API/web container IDs all changed |
| All persisted message rows | Same comparison digest, `726ae5cb140f83cde87a24877de19141` |
| Browser sessions | Both contexts reloaded without signing in again; Alice/Bob identities and live connections restored |
| Selected history | Same eleven canonical IDs in the same order in both browsers |
| Continued conversation | New Alice message confirmed in Bob's view; final counts `2/2/2/4/117` |
| Public health after recreation | Live/ready both 200; migration exited zero again |

Browser contexts and the raw test socket were closed. After verifying the
database's mounted volume name and its Compose owner label, only this disposable
stack, networks, volume and temporary credential file were removed. The secret-free
source clone was retained locally. Volume deletion was test cleanup only; normal
shutdown preserves the volume.

## CI and remaining scope

[Integrated baseline CI 39408568373](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39408568373)
passed Quality, Integration and Containers on `51eb848`. The task PR records
the additional checks against the final documentation branch. Existing tests
cover deeper identity, authorization, ordering, retry, recovery and shutdown
cases; this local smoke does not claim to repeat every negative case manually.

[Future deployment requirements](deployment-readiness.md) cover HTTPS, ingress,
proxy trust, secrets/roles, backups, migrations and operations without creating
a deployment. No public URL, registry publication, remote TLS verification,
load/multi-instance certification or rollback/restore exercise is included.
CP0-C and CP1-C remain pending; CP5-B must still review the complete A01–A18
evidence. Passing 5.3a does not silently close those gates.
