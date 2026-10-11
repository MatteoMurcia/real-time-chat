# Channel creation and discovery

Sign in and open `/workspace`. Create a channel with a display name and a slug.
The creator becomes its first member. Every authenticated user can discover it;
the directory shows **Member** or **Open channel** for the current user.
Joining/leaving, subscriptions and messages are subsequent tasks.

## HTTP contract

All paths use the `/api` prefix and return `Cache-Control: no-store`. Both
endpoints validate the existing HttpOnly session against PostgreSQL.

| Request | Response | Requirements |
| --- | --- | --- |
| `POST /channels` with `{ "name": "Design team", "slug": "design-team" }` | 201 `{ channel }` | JSON, exact origin/Referer and session-bound CSRF |
| `GET /channels?limit=50&cursor=…` | 200 `{ channels, nextCursor }` | Authenticated session |

Obtain fresh mutation CSRF from `GET /auth/session/csrf`. Do not supply user IDs,
creator IDs or membership data: unknown input fields are rejected. A public
channel contains only `id`, `name`, `slug`, `createdAt` (ISO timestamp) and
`isMember`; internal normalized names and sequence counters stay server-side.

- **Name:** trim, normalize Unicode NFC and collapse repeated ASCII spaces;
  2–80 Unicode characters consisting of letters, marks, numbers, spaces,
  apostrophes, periods or hyphens. Uniqueness uses the normalized name converted
  to lowercase, stored in `nameKey` with a unique constraint.
- **Slug:** trim; 3–48 lowercase ASCII letters/numbers separated by single
  hyphens. Uppercase, repeated/leading/trailing hyphens and duplicates are rejected.
- **Pagination:** 50 by default, 1–100 allowed. Ascending unique slug order, with
  an indexed `slug > cursor` boundary and one extra row to determine continuation.
  Pass `nextCursor` unchanged; null means the end. Cursors are canonical base64url
  of `v1:<slug>`, bounded and validated. They are not credentials or snapshots.
  New channels sorting before the current boundary appear after refreshing from
  the first page. The UI keeps one page in memory and retains it on failed reads.
- **Errors:** existing safe ApiError envelope; 400 invalid fields/query, 401
  missing/expired/revoked session, 403 CSRF/origin failure, 409 name or slug conflict.
  Database unique constraints arbitrate concurrent creates.

Creation uses one Prisma nested write for the channel and initial membership.
If membership insertion fails, the channel rolls back. Membership has a composite
user/channel primary key and foreign keys; no delete/update operations are exposed.
`lastSequence` starts at zero for the planned message sequence, but is not part of
this API. Membership data is filtered to the current user in a bounded relation
query, rather than fetching member lists or issuing a query per channel.

Creation is not an idempotent API. The browser blocks double submission but never
automatically retries a POST. After an uncertain result, it preserves input and
asks the user to refresh the directory; a confirmed duplicate returns 409.

## Verification and local operation

Use the [local Compose guide](local-development.md). The additive migration runs
through the existing migration service; stop/recreate the stack without removing
its volume when updating images. Older application images can ignore these new
tables, so rolling back application code does not require deleting channel data.

API tests cover validation, forged creator IDs, session CSRF, concurrent
uniqueness, creator/observer membership flags, pagination and a forced membership
constraint failure proving rollback. Chromium covers two independent users,
keyboard interaction, double submit, duplicates, read failure/recovery and
320/768/1024/1440 px layouts. Run the documented isolated E2E suite, never against
the working database. Rate limiting remains planned in 4.1a.

Reference: [Prisma 7 nested-write transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions).
