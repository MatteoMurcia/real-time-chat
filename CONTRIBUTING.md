# Contributing

## Work from the plan

[tasks/plan.md](tasks/plan.md) is the single implementation checklist. Choose a
task whose dependencies are complete, keep its acceptance criteria in scope,
and record verification evidence before marking it complete. Do not duplicate
the checklist in GitHub Issues or Projects.

The application runs locally with Docker Compose once that setup is implemented.
There is no hosting or deployment workflow in the current scope.

## Branches and pull requests

Start each task from an up-to-date `main` and use a short-lived branch:

- `feature/<task-id>-<description>` for functionality.
- `fix/<task-id>-<description>` for corrections.
- `chore/<task-id>-<description>` for tooling and repository setup.
- `docs/<task-id>-<description>` for documentation.

For example, task 0.1a uses `chore/0.1a-workspace`.

Open a pull request into `main` with a focused diff. Explain the resulting
behavior, link the plan task, list the checks actually run, and identify any
remaining limitations. Use a draft when acceptance criteria are still pending.

Review your own diff and resolve review conversations before merging. This is
a solo portfolio project: an external approval is not required. Merge with
**squash**, using a descriptive PR title as the final commit message; the source
branch is deleted automatically after merge. Avoid mixing unrelated tasks.

Agents must leave pull requests open for the repository owner to review and
merge. They may prepare commits, push the task branch, and document verification,
but must not merge a PR or enable automatic merging. The owner makes the final
merge decision even though GitHub does not require an external approval.

The initial repository bootstrap (0.0a–0.0c) is committed directly to `main`
before enabling its protection. Subsequent changes use pull requests.

## Commit messages

Implement, verify, and commit each coherent increment before starting the next.
Push those commits individually so the PR shows the development process. Do not
collapse the task into one commit or rewrite its history before owner review.

Use `<type>: <short description>` in English. Supported types are `feat`, `fix`,
`refactor`, `test`, `docs`, and `chore`. Add a body when the reason or tradeoff is
not clear from the title.

Examples:

```text
chore: initialize TypeScript workspaces
feat: persist channel messages before acknowledging sends
fix: reuse message identifiers when retrying unconfirmed sends
```

## Verification and completion

- Inspect the staged diff and run `git diff --cached --check` before committing.
- Verify the affected behavior and the task's acceptance criteria. Record the
  commands, results, and any manual checks in the PR and plan progress log.
- Keep credentials, environment files, generated output, and test artifacts out
  of commits. Track safe environment templates, lockfiles, and migrations.
- For documentation changes, verify links and consistency with the implemented
  state. Never describe planned commands or features as already working.

Run `npm test`, `npm run typecheck`, and `npm run build` from the root to check
both applications, or use `--workspace` to check one application during an
increment. The API uses Node's built-in test runner, including real HTTP checks;
the web uses Angular's Vitest runner with HTTP testing utilities. CI is still pending;
do not add placeholder success checks. Task **0.3b** introduces the CI
workflow and registers its actual successful job names as required checks on
`main`. Later tasks extend those checks with integration and E2E coverage.

## GitHub settings

Repository policy established in task 0.0c:

| Setting | Policy |
| --- | --- |
| Default branch | `main` |
| Changes to `main` | Pull requests required, including for administrators |
| Required approvals | Zero; self-review is expected |
| Review conversations | Must be resolved before merge |
| History | Linear, squash merges only |
| Force pushes and branch deletion | Disabled on `main` |
| Merged source branches | Deleted automatically |
| Required CI checks | Pending task 0.3b; none configured yet |

If GitHub settings change, update this table in the same task. The policy does
not include deployments, publishing container images, or external services.
