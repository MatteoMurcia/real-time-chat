# Keyboard, responsive layout and navigation QA

Task 4.2a, reviewed on 2026-10-18. This records concrete keyboard, focus and
announcement checks; it does not certify full WCAG or screen-reader support.

## Behavior

- Registration, login and workspace expose a focused heading after navigation.
  Programmatically focused headings stay outside the Tab order. Existing labels,
  error focus, skip link, landmarks and empty-state guidance are retained.
- Explicitly selecting a conversation focuses its heading, including when the
  component is reused for another channel. Incoming messages never request focus.
- Closing renders the removal before returning focus to Channels. A regression
  observes the DOM from that focus event: the old chat must already be absent.
  This fixes rapid close/reopen coalescing into an unchanged channel input.
- Plain Enter sends; Shift+Enter inserts a newline. Ctrl/Alt/Meta+Enter do not
  submit. Composition start/end, `isComposing` and legacy key code 229 protect
  both keydown and form submission. Accepted sends and explicit confirmation
  retries return focus to the editor; recovery retries focus the message log.
- Message rows remain outside automatic live announcements. One status outside
  the log summarizes pending/unconfirmed/rejected counts without message bodies;
  its explicit zero state also confirms successful acknowledgement-only sends.
  Retry controls have distinct accessible names by message position.
- Recovery announces one summary after all pages, including only newly merged
  rows. Its final sequence distinguishes successive equal-size batches. Empty
  polling stays silent; partial recoveries retain completed progress and expose
  the existing retry error. Visible polling progress has no live status role.
- The editor uses the existing input border token: approximately **6.08:1** on
  white, compared with the previous **1.48:1**. Focus outlines remain visible.

## Repeatable checks

Run `npm test --workspace @real-time-chat/web`. Component/store tests cover focus
destinations, the close-render boundary, composition/modifiers, aggregate
announcements, acknowledgement-only completion, multi-page recovery and equal-size
successive batches. The keyboard tests were red before their fixes.

Against the isolated compiled Compose application, run `npm run test:e2e` using
the environment variables described in [local development](local-development.md).
The added `e2e/keyboard.spec.ts` follows registration → login → create channel →
open chat → compose/send → close/reopen → select another channel with Tab/Enter.
It checks invalid-form focus, empty state and editor focus after button send.
Chromium's composition protocol exercises composing text; the 229 edge is an
explicit synthetic event. `conversation.spec.ts` checks a real second user's
message preserves the recipient's focused draft; `message-retry.spec.ts` checks
focus after retrying the same unconfirmed request.

## Evidence and limits

The parent independently performed an interactive browser walkthrough on the
initial keyboard image: registration, login, channel creation, message send,
close/reopen and persisted history. The editor retained focus after sending.
The slower interactive sequence did not reproduce the rapid-reopen race; the
automated focus-event regression did. A desktop screenshot was visually inspected
for focus visibility and layout. Browser artifacts/logs are local and ignored.

Final host verification: **102 Angular tests** across 13 files; lint, typecheck,
build and audit passed (zero vulnerabilities). Integration from the earlier
keyboard slice passed 21 results; this is not a fresh run of the final image.
Docker Desktop's Linux engine became unavailable during the final continuation.
The final compiled image was verified by GitHub CI instead:
[run 39168334708](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39168334708)
passed Quality and Containers, including **21 PostgreSQL integration results,
44 API tests, 102 Angular tests, 3 contracts, 3 Docker tests and 21 Chromium E2E
tests**. The browser suite completed in 1.5 minutes, with no skips or retries.

A controlled mutation made successive recovery summaries identical; two of the
32 store tests failed. Original source bytes were restored, and all 32 passed
again. This verifies that both batch summaries and their distinguishing sequence
are covered, including the New messages indicator's input.

The subagent's work and the final changes were independently reviewed. The review
caught missing real-message focus evidence and repeated equal-count summaries;
both are covered by regressions. No dependency, API, authorization or data schema
change is required.

No physical OS IME or screen-reader speech was tested. CDP events, DOM roles,
accessible names and focus assertions do not establish that assistive technology
announces every change correctly. No new automated accessibility package was
added. Mobile/20-channel navigation is recorded below; CP4-B, CP0-C and CP1-C
remain pending. This task does not certify other browser engines or a complete audit.

## Mobile layout and repeated navigation — 4.2b

Reviewed on 2026-10-18, after 4.2a was integrated through PR #45 (`fb155d3`).
The existing stacked directory/conversation layout and design tokens are retained.
Small screens use less surrounding spacing; long names and email addresses wrap
inside the main content instead of widening the page. A regression reproduced
horizontal overflow before this adjustment. No overflow is hidden to mask it.

The message log is capped at the smaller of 26rem and 45dvh. The viewport requests
`interactive-widget=resizes-content`, allowing supporting browsers to resize the
layout when the on-screen keyboard opens. This follows the
[Chrome viewport guidance](https://developer.chrome.com/blog/viewport-resize-behavior).
The editor and send control remain in normal document flow and can be scrolled
into view; no fixed overlay or viewport listener is introduced. Browsers that
ignore the viewport setting retain document scrolling.

Run `E2E_BASE_URL=<isolated-origin> npm run test:e2e -- e2e/responsive.spec.ts`
with the isolated stack described in [local development](local-development.md).
The test creates its own account and two channels, then checks:

- Widths 320, **375**, 768, 1024, **1280** and 1440px, including a 2,000-character
  unbroken message, long channel/display names and email. Neither document nor
  message log overflows horizontally. Screenshots record 375 and 1280px.
- Reducing the viewport to 375×400 preserves the focused editor and draft, shrinks
  the log to at most 180px, and permits scrolling the editor/send button fully into
  view. This simulates reduced space; it does not open a native mobile keyboard.
- **Twenty channel changes**, with five full close/remount cycles: exact message
  IDs/order, one live event per expected active-channel message, and no events
  from the channel just left. Captured WebSocket frames verify the exact
  subscribe/unsubscribe sequence, rather than relying on deduplicated UI rows.
- Chromium's event-listener inspection verifies one added window focus and
  document visibility listener while open, stable counts across changes and
  return to baseline on every close. Leaving/re-entering Workspace restores one
  working connection and conversation.

`chat.store.lifecycle.spec.ts` separately mounts/destroys twenty real stores and
checks socket handlers, exact DOM-listener removal, interval cleanup and cancelled
pending history requests. Framework zero-delay cleanup is drained before counting
remaining timers. A controlled mutation omitting `clearInterval` fails this test;
the original source was restored before rerunning **103 Angular tests** successfully.
Existing lifecycle code already met the requirement and required no production change.

Local browser checks ran against the real Angular UI with a disposable HTTP/socket
fixture solely for layout/navigation feedback. Mobile, desktop and reduced-height
screenshots were visually reviewed. Docker's Linux engine remains unavailable;
actual database/API/socket verification ran in the existing full-stack CI instead.
[Run 39170035297](https://github.com/MatteoMurcia/real-time-chat/actions/runs/39170035297)
passed Quality and Containers on `893e9ef`: **44 API, 103 Angular, 3 contracts,
3 Docker, 21 PostgreSQL integration results and 22 Chromium E2E tests**. All E2E
passed in 1.5 minutes without skips or retries; audit reported zero vulnerabilities.
Independent review found no blockers; its suggestion to send after Workspace
re-entry was added and verified. The parent reviewed the final diff and screenshots.
Task 4.2b was integrated through PR #46 (`50631a9`) on 2026-10-19.
The local fixture is ignored and never shipped.

No physical phone keyboard, iOS/Safari, other browser engine, screen-reader speech
or full accessibility audit was checked. Native keyboard behavior still requires
device verification. Existing primary data/environment were not modified, and no
dependency, API or schema change is introduced. [CP4-B](checkpoints/cp4-b.md) now
records fresh full-stack screenshots, repeated checks and a corrected test race
after 4.3a; CP0-C and CP1-C stay pending.
