# Demo recording and narration

This walkthrough shows the real local application with fictional seeded accounts.
Alice is the recorded viewpoint; Bob uses an independent browser context outside
the recording. Both are already authenticated, keeping passwords out of the clip.
There is no special demo panel or simulated application response.

## Watch and inspect

- [Download/play the original WebM](assets/demo.webm).
- [English captions](assets/demo.en.vtt), timed to the recording.
- [Capture measurements](assets/capture.json), including phase times and row counts.
- [Desktop overview](assets/overview-desktop.png) and [mobile overview](assets/overview-mobile.png).
- [Desktop conversation](assets/chat-desktop.png) and [mobile conversation](assets/chat-mobile.png).
- [Disconnected](assets/chat-offline.png) and [recovered](assets/chat-recovered.png).

Open the downloaded WebM in a browser or a player supporting VP9. In a player
supporting external subtitles, load `demo.en.vtt`. The clip has no audio; the
following script also provides an accessible text account of the actions.

## English presentation script

The exact phase boundaries are in `capture.json`; timings vary when recapturing.

| Scene | Action and narration |
| --- | --- |
| Open | “Alice is signed in. Open Demo Planning, a channel shared with Bob.” Six seeded messages load. |
| Send | Type **Can we review the release checklist here?** “Confirmed means the message was saved. It does not mean somebody read it.” |
| Reply | Bob sends **Yes. I will check the rollout notes.** “This reply comes from a separate authenticated session.” Alice now has eight saved messages. |
| Disconnect | Interrupt only Alice’s connection. Show **Connection interrupted. Reconnecting…** “The server and Bob remain connected.” |
| Keep a draft | Alice types **Back online. Thanks for checking the plan.** Send stays disabled. Bob sends **The checklist is ready for review.** and **I also checked the migration plan.** Alice still has eight saved messages. |
| Recover | Restore Alice’s network. “The live connection returns. Bounded HTTP recovery fills the gap.” Both missed messages appear, giving ten distinct saved message IDs. The unsent draft is retained. |
| Finish | Send the retained draft. “This is a manual send after reconnecting, not a durable offline queue.” Both sessions see the same confirmed message; the channel now has eleven messages. |

For a manual presentation, prepare the [dedicated demo](demo.md), sign in with
Alice and Bob in separate browser/private sessions and open Demo Planning.
Control Alice’s network outside the recording with browser network tooling;
verify her live connection actually drops before sending from Bob. Do not stop
the server or disconnect Bob. Keep the offline controls and credentials out of
the captured area. Ordinary tabs share cookies and are not independent accounts.

## Reproduce the capture

The app itself needs only Docker. Automated recording additionally uses the
[optional pinned host toolchain](../README.md#optional-host-development-toolchain)
and the already pinned Playwright dependency: run `npm ci` and
`npx playwright install chromium` from the repository root.

Create a **new disposable** environment file named `.env.demo.recording` from
`.env.demo.example`; fill the three local-only passphrases as in the demo guide.
Keep it untracked. Set `WEB_PORT=18087`, `APP_ORIGIN=http://127.0.0.1:18087`,
`BACKEND_SUBNET=172.29.46.0/24` and `PROXY_IP=172.29.46.254`, or choose another
free port/subnet and matching origin/proxy. Preserve any ordinary `.env` and demo.

Use a new project name matching `demo-recording-` plus eight lowercase hex digits.
The following example must name an unused project. Run commands individually and
stop on errors:

```text
docker compose -p demo-recording-0123abcd --env-file .env.demo.recording -f compose.yaml -f compose.demo.yaml up --build --wait
docker compose -p demo-recording-0123abcd --env-file .env.demo.recording -f compose.yaml -f compose.demo.yaml --profile tools build seed reset
docker compose -p demo-recording-0123abcd --env-file .env.demo.recording -f compose.yaml -f compose.demo.yaml --profile tools run --rm seed
```

Set the recorder variables in PowerShell (use the actual selected project/port):

```powershell
$env:E2E_COMPOSE_PROJECT = 'demo-recording-0123abcd'
$env:E2E_COMPOSE_ENV_FILE = '.env.demo.recording'
$env:E2E_BASE_URL = 'http://127.0.0.1:18087'
node --env-file=.env.demo.recording scripts/capture-demo.mjs
```

The recorder checks the actual web container labels/port, API origin and demo
database marker before any browser login. It requires a fresh seed with
User/Session/Channel/Membership/Message counts **2/0/2/4/111**. It refuses an
existing `test-results/demo-media/demo.webm`; preserve previous takes elsewhere
before retrying. Do not run it against a demo people are using. To start again,
follow the demo guide’s stop → reset → seed → restart sequence with **this**
project and environment on every command. Recording adds two sessions and five
messages; seeding again alone does not restore the initial state.

Playwright takes only Alice offline and closes her routed WebSocket, then
restores her network. This is a controlled client interruption against the real
Docker API/database. Assertions check disabled sending, delivery in both
contexts, retained draft, a successful HTTP sync response containing both missed
messages, and distinct canonical IDs. Reading pauses follow successful assertions;
there are no fabricated DOM states or edited message statuses.

Inspect the full clip and screenshots before copying approved files from
`test-results/demo-media` to `docs/assets`. Never publish raw browser storage,
traces, environment files or authentication screens. Shut down only the explicitly
selected disposable project. Volume removal is optional and destructive; confirm
its actual volume mount/project ownership first. Keep normal development data.

## Provenance and limits

Captured on 2026-10-20 from application commit `c0ef863` (merged CP5-A), using
Chromium, Docker Compose and native Playwright WebM/VP9 recording. Desktop viewport
is 1280×900; mobile screenshots use 375×812 with no document horizontal overflow.
Screenshots capture the full page; the message log retains its own scroll position.
Only synthetic demo names, reserved `.test` emails and fictional messages appear.
Credentials are entered before recording and session state stays in memory.

The JSON measures script phases; the native video can include a short startup or
finalization interval. Captions use script phase times. This is a functional
walkthrough, not a latency benchmark, mobile-device test or accessibility audit.
It demonstrates recovery of this bounded gap, not exactly-once delivery, durable
offline sending, multi-instance operation or production deployment. Installation
evidence is in [CP5-A](checkpoints/cp5-a.md); final delivery verification remains
the separate 5.3a task in the [plan](../tasks/plan.md).
