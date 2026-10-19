# CP4-C — Functional P0 exit

Review date: **2026-10-19**. Baseline: `185b28da470cdd9f785359afd7aa29bdd394e088`
on `origin/main`, with shutdown task 4.4b merged through PR #51.

**Verdict: verification in progress.** This checkpoint checks A01–A16 against
assertions, connected implementation and a complete compiled-stack run. A green
job alone is not a substitute for checking what each test actually proves.
No additional product features belong to this checkpoint.

## Acceptance evidence

Paths in this table are relative to `e2e/`, unless marked API or Angular.
Integration means real PostgreSQL and real application services, not browser
coverage. Unit tests use controlled dependencies/time where explicitly stated.

| ID | Required behavior | Concrete evidence to verify |
| --- | --- | --- |
| A01 | Register/login/reload/logout | `register.spec.ts`, `session.spec.ts`: persisted session, reload restoration, logout and rejected old cookie; separate session survives. |
| A02 | Nonmember denied | `subscriptions.spec.ts` and API integration: history, subscribe and send fail for an authenticated outsider. |
| A03 | Ten concurrent retries | `message-order.spec.ts`: identical canonical acknowledgements, one history item and one visible row. API `integration/messages.ts` also checks one publication and row. |
| A04 | Changed body/channel conflicts | `message-order.spec.ts`, API `integration/message-idempotency.ts`: conflict without another write, including concurrent changed-channel keys. |
| A05 | Commit with lost ack | `message-retry.spec.ts`: held/lost real confirmation, original-key automatic/manual retry, one canonical result; API integration checks one publication. |
| A06 | Event/ack in either order | `message-order.spec.ts`: release each real frame first in separate cases; first receipt clears pending, second leaves one canonical row with HTTP recovery disabled. |
| A07 | More than two missed pages | `reconnect.spec.ts`: 105 messages, three pages, fixed upper boundary, exact ordered IDs and retained draft. |
| A08 | Commit without emission | API `integration/commit-emission.ts`: persisted message recovered by the still-connected receiver over HTTP. `sync-gap.spec.ts` covers suppressed frames and focus recovery; Angular store test separately advances 15 seconds without focus to prove periodic recovery. |
| A09 | Delayed transaction and concurrent writers | API `integration/message-sync-races.ts`: PostgreSQL barriers observe writer/sync/concurrent send waits for commit and rollback; no canonical message is lost behind the recovery cursor. |
| A10 | Initial snapshot/live/channel races | `channel-races.spec.ts`: stale A/B responses and events around snapshots do not mix channels or advance the recovery cursor from a live event. |
| A11 | Subscribe/send versus leave | API `integration/subscriptions.ts`: barriers enforce both operation orders; send-first persists once, leave-first cannot write. |
| A12 | Revoked/expired idle sockets | API `integration/socket-session.ts`, `session-revocation.spec.ts`: inactive sockets close, cannot resume access, and another session stays valid. |
| A13 | Origin/CSRF/hostile payload | HTTP integration and `subscriptions.spec.ts`: foreign origins and missing/foreign CSRF rejected; `conversation.spec.ts`: hostile HTML is literal before/after reload, with no active descendants or execution marker. |
| A14 | Restart and converge from DB | `shutdown.spec.ts`: real deferred commit, no visible row/success ack while held, SIGTERM, ready 503/live 200, refused new work, exit 0, lost ack/event, automatic reconnect, exact recovered DB ID and same-key retry. API `integration/shutdown.ts` also checks rollback, stuck send and leaked-handle deadlines. |
| A15 | Preserve reading while paging | `history-scroll.spec.ts`: 1280/390px, same visible anchor within 2px through live arrivals, failed history, retry, held response and movement during loading. Focus and bottom-follow behavior are asserted separately. |
| A16 | Keyboard/reflow/repeated navigation | `keyboard.spec.ts`, `responsive.spec.ts`: keyboard flow and focus; six widths, reduced height, twenty channel changes, five remounts, exact subscription frames/IDs and DOM-listener baseline. CI repeats both three times. |

## Parent review of shutdown and interaction

Shutdown admission is centralized in `ShutdownState`; HTTP has gates before body
parsing and at controller admission, while gateway authentication and operations
participate explicitly. The drain precedes Nest provider disposal. Success stays
after the existing transaction/publication path; transport closure preserves
automatic reconnection. The 8-second hard deadline and Compose's 12-second grace
remain in force. Acknowledgement delivery itself cannot be guaranteed.

The shutdown E2E's Docker wait is asynchronous: the Node sender and routed browser
sockets must keep processing close handshakes. The synchronous-wait regression
and its real-WebSocket reproduction are recorded in [operations](../operations.md).
The strict exit-0 assertion was preserved. Test faults live outside the runtime
image; Docker actions verify a disposable project before touching containers.

Chat's render handling retains the currently visible DOM anchor and adjusts its
offset after prepending history. Near-bottom following is separate from reading
above. Composition/modifier guards prevent accidental sends; store destruction
clears socket/DOM handlers, recovery interval and pending requests. Responsive
tests wait for each Workspace transport upgrade before asserting WebSocket frames.

## Verification record

Local lint, types, unit suites and build are being executed from the baseline.
Full PostgreSQL, Nginx, compiled Angular and container evidence will come from
Linux CI. Docker Desktop's local Linux engine is unavailable; no restart or
primary-volume operation is part of this review.

An independent review checks A01–A13 against actual assertions and connected
code. The parent reviews A14–A16, all findings and run results before the verdict.
The final record must include exact tested revisions, counts and cleanup outcomes.

## Limits and next step

The scope is the planned single-instance functional P0 under the tested
conditions. Chromium viewport/protocol tests do not certify other browser engines,
physical mobile keyboards, OS IME behavior, screen readers, load capacity or
multi-instance coordination. SIGKILL/host failure cannot drain; persisted writes
need recovery with their original client key. Traces contain unredacted synthetic
credentials and expire after seven days; app logs follow a separate allowlist.

CP0-C and CP1-C remain explicitly pending. A17–A18, seed, clean-clone instructions,
demo and portfolio presentation remain stage 5 work; completing CP4-C does not
claim those delivery requirements are done. If verified, the next task is
**5.1a — Create demonstration seed**, with user review/manual merge of this
checkpoint's PR before continuing. Nothing is deployed or merged by the agent.
