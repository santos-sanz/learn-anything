# Development loop

This file defines the development workflow for this repository. It does not authorize production deployment, spending, disclosure of private data or changes to external accounts.

## Pick work

1. Read README.md, BACKLOG.md and the selected issue. Epics track outcomes; implement stories.
2. Use the execution queue in EXECUTION_ORDER.md. Start the earliest open story whose prerequisites are closed and whose acceptance criteria are understood. Do not skip a prerequisite because a later number looks simpler.
3. Check open pull requests, issue comments and branches before starting. If someone is already working on the story, avoid duplicate work. Record an explicit claim in the issue when the configured development pipeline has permission to comment.
4. If a requirement, dependency or provider contract is unclear, write the blocker and stop that story. Continue only independent ready work.

## Implement one story

- Branch from current main: `feat/issue-N-short-name`, `fix/issue-N-short-name` or `docs/issue-N-short-name`.
- Keep the change inside the issue scope. New features, broad refactors or architecture changes need a separate reviewed issue.
- Use small descriptive commits. Verify the Git commit identity is a private GitHub noreply address before pushing; never publish a personal email unintentionally.
- Add migrations rather than editing an applied migration. Test forward migration and reset using synthetic data.
- Do not commit secrets, live documents, raw audio, account exports or private fixtures. Use mock provider responses and example configuration with empty values.
- Never weaken RLS, tenant isolation, session verification or privacy rules to make a test pass.

## Validate

Run the repository's documented lint, typecheck, tests and build commands. Once they exist, use the pinned toolchain and lockfile. Do not invent successful test results when tooling is not yet set up.

For backend/data changes, test two-user isolation and error paths. For voice changes, test real microphone/playback behaviour and cancellation. For UI or Markdown diagrams, render and inspect desktop/mobile screenshots or previews. Provider calls are opt-in smoke tests only; ordinary CI must not consume paid quota or require live secrets.

Record test commands, pass/fail results, omitted checks and reasons. A skipped or unverifiable check is not a pass.

## Pull request and review

1. Open a draft PR early if coordination needs it. Use `Closes #N` only for the story actually completed.
2. PR body: goal, changes, acceptance checklist, dependencies, migration/rollback notes, test evidence, screenshots when visual, and known limits.
3. Ask a separate reviewer to inspect the diff and acceptance criteria. The implementer must not treat its own approval as independent review.
4. Resolve comments with code or a clear explanation. Re-run affected checks after every meaningful revision.
5. Refresh from main and rerun required checks before merge. Do not bypass failing or missing checks.

## Merge

Merge only when all required checks pass, all acceptance criteria are met, review is complete, prerequisite PRs are merged, and the repository's configured pipeline or owner permits that merge. This file is a workflow, not a new auto-merge grant.

Prefer squash merge for one-story PRs. Keep the issue reference and useful change summary. Do not force-push main, disable branch protection or change repository visibility to finish a task. Production deployments and paid resource creation are separate decisions.

## Close the loop

- Verify the merged commit is on main and the issue is closed. Never close an unfinished issue because its PR was merged.
- If partial work merged, list remaining criteria and leave the issue open.
- Update the next ready story's dependency status and remove `blocked` only after its prerequisites are verified complete.
- Close an epic only when every child story and the release acceptance test have passed.
- Report what merged, links to PR/commit/issue, tests, and remaining blockers. Keep failures visible.

## Recovery

Before retrying a create, comment, push or merge after interruption, read current remote state. The previous action may have succeeded. Do not duplicate PRs/issues or merge twice. A failed live provider request gets bounded retries and a visible error; never switch providers or credential owners silently.
