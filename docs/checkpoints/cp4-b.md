# CP4-B — Usability and reproducible integration

Reviewed on **2026-10-19**, starting from `origin/main`
`afe29e8ef116271954bf53a6c028e66fe1cd35d4`, with 4.3a integrated by PR #47.
Scope: 4.2a keyboard/focus/IME safeguards, 4.2b responsive layout and repeated
navigation, and 4.3a isolated container integration. CP0-C/CP1-C remain pending.

**Verdict: verified for this scope.** Independent code review and parent
reproduction corrected one test timing defect. Fresh real-stack CI, repeated
usability checks and parent visual review are complete. Owner review/manual merge
of PR #48 remains pending. No product behavior changed.

## Acceptance and evidence map

| Criterion | Concrete checks |
| --- | --- |
| Desktop keyboard flow | `e2e/keyboard.spec.ts`: registration → login → create channel → open → compose → close/reopen → switch with Tab/Enter; error focus, accessible headings, modifier/composition guards and editor focus. |
| Stable reading and focus | Conversation E2E preserves a focused recipient draft on a real incoming message; history-scroll and initial-load race E2Es exercise anchors and stale responses. Component/store tests cover focus/render timing and aggregate notices. |
| Mobile and desktop reflow | Responsive E2E checks document/log overflow at 320, 375, 768, 1024, 1280 and 1440px with long names/email and a 2,000-character unbroken message. |
| Reduced available height | 375×400 retains focused draft, limits the log to ≤180px and scrolls editor/send fully into view. The viewport opts into keyboard-driven layout resize where supported. This is viewport simulation, not a physical keyboard test. |
| Twenty channel changes | Exact message IDs/order, subscribe/unsubscribe frames, active/inactive delivery and stable DOM-listener counts; five full close/remounts return to baseline. Workspace re-entry checks live delivery after its own transport upgrade. |
| Destruction cleanup | Twenty component-provided stores release socket/DOM handlers, recovery intervals and pending HTTP history; the earlier interval-removal mutation failed its regression. |
| Empty database per scenario | Test setup creates private `suite_<uuid>_test` databases from template0, deploys committed migrations and asserts five empty tables before each of 19 scenarios. Minimal constraint fixtures belong to each scenario. |
| Order independence and cleanup | Integration CI runs 21 results in each order on the same PostgreSQL instance and checks no generated databases/base public tables after each pass; scenarios are serial because the quota fixture changes the process clock. |
| Real failure propagation | The 4.3a controlled assertion in [CI 39171553695](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39171553695) failed Integration with exit1 while cleanup/teardown passed; its removal is committed and no probe remains. |

## Finding and correction

**P2 — The responsive test could mistake correct polling delivery for message loss.**
Each Workspace creates a new Socket.IO connection, starting with polling and then
upgrading asynchronously. The test collected live frames only from WebSocket and
waited for the first upgrade. After leaving/re-entering Workspace, it sent as soon
as connected without waiting for that second connection's upgrade. A legitimate
polling-delivered message appeared in the UI but was absent from its frame list.

The parent reproduced this with the real Angular UI and a disposable Socket.IO
fixture that held the second HTTP upgrade for **3,000ms**. The original test failed
its final frame assertion; fixture observation confirmed delivery over polling.
The fix counts completed upgrades and waits for the second before requiring a
WebSocket frame. The same delayed-upgrade fixture passed **3/3** repetitions and
confirmed WebSocket delivery. No deadline, retry, product transport, assertion or
user-facing behavior was relaxed. Local logs/fixture are ignored and not shipped;
they establish this transport race, not API/auth/database correctness.

## Fresh compiled-stack verification

The merged baseline [CI 39172621668](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39172621668)
passed Quality, Integration and Containers, including both 21-result integration
passes. The checkpoint adds a bounded stability gate: the existing full browser
suite stays intact, then keyboard/responsive each run three times (six repeated
executions, not six new scenarios). Playwright retains one worker and zero retries.

Only keyboard/responsive PNGs are uploaded after the repeated invocation, using
the SHA-pinned `actions/upload-artifact` v7.0.2 with **seven-day retention**.
The allowlist excludes environment files, cookies, traces and arbitrary reports.
Fixtures contain synthetic identities/messages. Each attempt has a unique artifact
name; missing screenshots fail the capture step. Playwright clears output between
invocations, and the keyboard filename represents its last repetition. Full trace
and critical-flow reporting remain task 4.3b.

[CI 39209784918](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39209784918)
on `fdc4b20` passed all three jobs: **45 API, 103 Angular, 3 contracts, 5 Docker,
21 integration results in each order and 22 Chromium E2Es**. The full browser
suite completed in 1.4 minutes; all **six repeated keyboard/responsive executions**
passed in 14.9 seconds. No skips, cancellations or retries were used to pass;
dependency audit found zero vulnerabilities. Both integration cleanup queries
and stack teardown succeeded.

The parent downloaded the [usability artifact](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39209784918/artifacts/12167237635)
(`usability-39209784918-1`, ten PNGs, about 4MB) and visually inspected four
representative images across the three repetitions:

- `responsive-375.png` from repeat2: long names/email/slugs wrap, channel controls
  remain inside their panels and the editor retains its visible focus outline.
- `responsive-1280.png` from repeat1: centered desktop content, visible conversation
  controls, readable message cards and editor; long identifiers stay within panels.
- `responsive-reduced-height.png` from the first repetition: editor, helper text
  and Send control remain accessible in the 375×400 capture, without a fixed overlay.
- `keyboard-desktop.png` from the last keyboard repetition: focus is on the newly
  selected channel heading; the empty state, editor and channel form are visible.

The stress directory is deliberately long and scrolls vertically. Automated
geometry checks cover all six widths in each repetition; this sample visual
review covers the pictured states, not every possible message or device.
Artifacts expire after seven days (this one on 2026-10-26); the tests and workflow
reproduce the evidence. Local downloads/logs remain ignored and are not shipped.

The parent reviewed source, assertions, the local red/green reproduction, fresh
CI logs and images after the subagent's audit. No required findings remain. The
only correction is the test transport wait; app behavior and quality thresholds
are unchanged. A final documentation commit records this verdict and the plan.

## Limits and next step

Docker Desktop's Linux engine is unavailable locally. Actual PostgreSQL/compiled
application evidence comes from GitHub's disposable Docker runner; the local
delayed-upgrade fixture is not substituted for it. Primary environment, data and
volumes are preserved. Nothing is deployed and no production dependency/API/schema
changes are needed.

No physical mobile keyboard, native OS IME, iOS/Safari, other engine, screen-reader
speech or full accessibility certification is claimed. Repeated green executions
are a bounded flakiness check, not proof of universal reliability. Earlier QA and
integration evidence remain in [QA](../qa.md) and
[local development](../local-development.md#reproducible-integration-in-containers).

The owner reviews/merges manually. Next task after this checkpoint is **4.3b**;
CP0-C, CP1-C and CP4-C remain pending.
