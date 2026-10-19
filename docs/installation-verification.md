# Clean-checkout installation verification — 5.2a

On 2026-10-19 the documented Docker flow was exercised in a separate clone of
`docs/5.2a-installation-architecture`, initially `0a57282`, then fast-forwarded to
`741305a` for the reviewed port/origin instructions. Application/configuration
files are unchanged from merged 5.1b (`7dcbd67`). This records the installation
walkthrough; CP5-A and final delivery/presentation remain separate gates.

## Environment and isolation

Host: Windows with Docker Desktop's Linux engine, Docker Engine 29.8.2. The clone
was fetched from GitHub, not copied from the existing working tree. Before and
after the flow, it had no host `node_modules`, generated Prisma client or web
build output. Its tracked files remained clean. No host npm, Node or PostgreSQL
command was used to build, migrate, seed or run this installation.

The `.env.example` template was copied locally, preserving its database/role.
Three random local-only passwords were supplied for PostgreSQL and the two demo
accounts. The test used project `readme-check-4285c421` (via `COMPOSE_PROJECT_NAME`
in its ignored `.env`), port `18085`, matching
`APP_ORIGIN=http://127.0.0.1:18085`, subnet `172.29.44.0/24` and proxy
`172.29.44.254`. This kept the ordinary `.env`, application volume and other
projects separate. Those substitutions follow the README's port/origin and
subnet configuration, not a different application image or database URL.

## Observations

| Documented operation | Observed result |
| --- | --- |
| Clone, copy/configure environment, `docker compose config --quiet` | Valid configuration; no host-generated application files |
| `docker compose up --build --wait` | Database/API/web healthy, migration exited zero; API/database not published, web bound to loopback |
| Check migrated database before seed | Three migrations completed; no unfinished/rolled-back migration; User/Session/Channel/Membership/Message counts `0/0/0/0/0` |
| Public `/api/health/live` and `/api/health/ready` | HTTP 200 with `{"status":"ok"}` and `{"status":"ready"}` respectively |
| Build seed tool, run `docker compose --profile tools run --rm seed` twice | Both runs succeeded; counts `2/0/2/4/111` after the second run |
| Clean browser → demo sign-in → Demo Lounge | Alice authenticated; live connection established; 50 canonical history rows and enabled earlier-history button |
| `docker compose ps -a`, normal `down`, then `up --build --wait` | Named volume retained; counts `2/1/2/4/111` unchanged; migration exited zero again |
| Reload `/workspace` after recreation | Existing session restored; Alice visible and live connection established |
| Development override `config --quiet` | Valid merged Watch configuration; source reload was not re-exercised in this task |

BuildKit could reuse matching image layers. All application build/test tooling
used by this flow runs inside the Dockerfiles, not against local dependencies.
The browser was checked through browser tools; no claim is made about a human
usability study or a new physical machine's installation experience.

## Review and cleanup

The diagram/module/guarantee descriptions and three new ADRs were compared with
their referenced source and tests. Local checks resolved 108 relative links and
anchors across README, architecture and ADRs, plus tracked links into README.
Independent review found and resolved the missing matching origin when changing
ports, clarified optional host tooling, and corrected delivery-status text. No
required findings remained after parent review. Existing ADR-001 and its directory
convention were preserved; there are no runtime, schema or dependency changes.

After verifying the test database container's mount belonged to its generated
project, the disposable containers/networks/volume and ignored credential file
were removed. Volume deletion was test cleanup only: the normal documented stop
is `down` **without `--volumes`**. Existing development data was not reset or moved.

The [pull request](https://github.com/MatteoMurcia/real-time-chat/pull/55) records
the final CI result and is left for owner review/manual merge. Optional host
development, Watch reload, physical devices, performance/load, deployment and
CP0-C/CP1-C are not newly certified by this walkthrough.
