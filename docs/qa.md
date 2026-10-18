# Desktop keyboard and accessibility QA

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
The final compiled-image keyboard and full browser regression therefore require
the PR's Quality and Containers checks; their status is recorded in the PR.

The subagent's work and the final changes were independently reviewed. The review
caught missing real-message focus evidence and repeated equal-count summaries;
both are covered by regressions. No dependency, API, authorization or data schema
change is required.

No physical OS IME or screen-reader speech was tested. CDP events, DOM roles,
accessible names and focus assertions do not establish that assistive technology
announces every change correctly. No new automated accessibility package was
added. Mobile/20-channel navigation is task 4.2b; CP4-B, CP0-C and CP1-C remain
pending. This task does not certify other browser engines or a complete audit.
