# Local demo access and maintenance

This optional installation uses its own Compose project, PostgreSQL database and
volume. It runs on loopback only; there is no hosted demo. Only Git and Docker
with Compose and Linux containers are required on the host.

## Prepare the dedicated demo

From the repository root, copy `.env.demo.example` to `.env.demo`. Set a dedicated
`POSTGRES_PASSWORD` and two different local-only `DEMO_ALICE_PASSWORD` and
`DEMO_BOB_PASSWORD` passphrases (15–128 Unicode characters). Keep the database/user
values in the template. Do not reuse personal passwords or commit the filled file.

Every command below explicitly selects the demo project, environment and both
Compose files. Keep those arguments together, including for maintenance.

```text
docker compose -p chat-demo --env-file .env.demo -f compose.yaml -f compose.demo.yaml config --quiet
docker compose -p chat-demo --env-file .env.demo -f compose.yaml -f compose.demo.yaml up --build --wait
docker compose -p chat-demo --env-file .env.demo -f compose.yaml -f compose.demo.yaml --profile tools build seed reset
docker compose -p chat-demo --env-file .env.demo -f compose.yaml -f compose.demo.yaml --profile tools run --rm seed
```

Open <http://127.0.0.1:18084>. If this port/subnet is occupied, change `WEB_PORT`
and matching `APP_ORIGIN`, or `BACKEND_SUBNET` and matching `PROXY_IP`, in
`.env.demo` before starting. The ordinary development `.env` and
`real-time-chat_postgres_data` volume are separate. The demo uses
`chat-demo_demo_postgres_data`, database `chat_demo` and role `demo_local`.
On first initialization, PostgreSQL marks this fresh database as the dedicated
demo. An existing unmarked volume is refused by the reset tool; do not add the
marker to an arbitrary database to bypass the guard.

## Start two independent sessions

The overview's **Try the local demo** section gives the same route into the app.
The operator supplies the two local passwords; they are never displayed by the
page or built into the browser bundle.

1. Click **Sign in to the demo**. Use `alice@demo.example.test` and the local
   `DEMO_ALICE_PASSWORD`, then open **Demo Lounge**.
2. Open the URL in a private window or another browser. Use
   `bob@demo.example.test` and `DEMO_BOB_PASSWORD`, then open the same channel.
   Two ordinary tabs share cookies and do not give independent accounts.
3. Send a message and check it appears in both windows. Reply from Bob. Use
   **Load earlier messages** twice to inspect the 105 seeded Lounge messages;
   **Demo Planning** starts with six. See [seed behavior](demo-seed.md) for reruns.

All demo accounts, channels and messages are shared inside this installation.
Other participants can read joined channels. Use fictional content only. Reset
deletes **all** users, sessions, memberships, channels and messages in this demo
database, including anything added by visitors.

For the manual first-message check, start timing when the prepared overview opens
in a clean browser session; stop when Alice's first sent message is confirmed.
The target is less than two minutes. Exclude downloading images, building and
seeding. Record the operator's time separately from automated browser timing.

## Reset manually

Tell participants first, then run these commands individually. **Stop if any
command fails**; keep API/web stopped until reset and seed have both succeeded.

```text
docker compose -p chat-demo --env-file .env.demo -f compose.yaml -f compose.demo.yaml stop api web
docker compose -p chat-demo --env-file .env.demo -f compose.yaml -f compose.demo.yaml --profile tools run --rm reset --confirm chat_demo
docker compose -p chat-demo --env-file .env.demo -f compose.yaml -f compose.demo.yaml --profile tools run --rm seed
docker compose -p chat-demo --env-file .env.demo -f compose.yaml -f compose.demo.yaml up -d --wait
```

Reset is an explicit one-shot tool; there is no browser reset button or HTTP
endpoint. It requires the exact confirmation, the internal `db:5432/chat_demo`
connection with role `demo_local`, and the actual database's initialization
marker. Missing/wrong targets fail before deleting rows. Host `DATABASE_URL`
does not configure Compose services. Do not change connection guards, mark an
existing database or use volume deletion to work around a refusal.

The delete runs in one transaction, sharing the seed's advisory lock, without
`CASCADE`. Reset and subsequent seed are separate operations. Stopping API/web
prevents ongoing conversations from racing maintenance. If seed fails after a
successful reset, the demo remains empty until seed succeeds; no success message
claims the whole maintenance sequence is atomic.

After restart, existing sessions are rejected and connected windows return to
sign-in. Sign in again with the same configured demo passwords. Visitor-created
channels and messages are gone, and the seeded 105/6-message conversations return.
Stop normally with the same explicit Compose arguments followed by `down`,
**without `--volumes`**. Normal reset does not delete the volume or migrations.

## Verification and limits

`npm run test:demo` checks connection/confirmation/marker guards and safe CLI
errors. `e2e/demo-maintenance.spec.ts` creates an extra disposable demo stack,
checks two clean browser contexts, times the first confirmed message, rejects
unsafe resets, performs the documented maintenance sequence, rejects old cookies
and channels, and checks a canary message in the unrelated base stack survives.
It removes only its generated project's volume. Run the full E2E suite only
against the disposable stack documented in the root README; traces contain
synthetic credentials and session data. CI withholds artifacts if either stack's
cleanup fails.

[CI 39317856292](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39317856292)
on `d43c113` passed Quality, Integration and Containers: 53 API, 103 Angular,
three contract, seven reset-guard and five Docker checks; 23 integration results
in each order; 29 Chromium E2Es and six usability repetitions. The automated
first confirmed demo message took **907 ms**, excluding build/seed. Both stacks'
cleanup and artifact publication passed. Desktop/mobile overview and post-reset
screenshots were reviewed without new visual issues.

On 2026-10-19, an agent also completed an interactive, step-by-step local browser
check in **14.644 seconds**: overview → sign-in → Demo Lounge → write/send →
observe **Confirmed**. Timing began immediately before opening the prepared
overview and ended after observing confirmation. The browser started at
`about:blank` with zero cookies verified; build/seed and credential preparation
were excluded. This was an exploratory browser-tool walkthrough, separate from
the scripted E2E, and satisfies the plan's manual first-message check. It is not
a human usability study or a measurement of a person's reading/typing speed.
The documented reset sequence also ran locally and returned the old session to
sign-in. Temporary demo data and credentials were removed afterward.

Local lint, types, unit suites, Docker checks, application builds and compiled
seed build passed. Removing the marker guard temporarily made its regression
test fail; the guard was restored and the seven checks passed again. Independent
and parent review found no remaining required changes. The subsequent
[clean-checkout installation walkthrough](installation-verification.md) is
implemented by 5.2a (merged PR #55). The [plan](../tasks/plan.md) tracks checkpoint
review, presentation and final delivery separately.
The subsequent [CP5-A review](checkpoints/cp5-a.md) reproduces this demo from a
fresh clone of integrated main.
