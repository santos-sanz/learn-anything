# Contributing to Learn Anything

## Before starting

Read `README.md`, `BACKLOG.md`, the selected issue, and the relevant ADRs in
`docs/adr/`. Follow `EXECUTION_ORDER.md`: start only the earliest ready story
whose prerequisites are closed and verified. Check open pull requests, issue
comments, and branches first so work is not duplicated.

Every issue must state its explicit prerequisites (or `None`), scope
exclusions, observable acceptance criteria, and required test evidence. If a
provider contract, prerequisite, or requirement is unclear, record the blocker
and do not start dependent work.

## Focused pull requests

Create one focused pull request for one issue. Branch from current `main` as
`feat/issue-N-short-name`, `fix/issue-N-short-name`, or
`docs/issue-N-short-name`; do not combine unrelated refactors or new features.
Use the pull request template to link the issue, state scope, map acceptance
criteria, list exact test results, and document dependencies plus migration or
rollback notes.

Do not merge unless the required checks, review, prerequisites, and repository
rules are complete. A merged PR does not close an unfinished issue.

## Fixture and provider policy

Default tests and CI use only synthetic fixtures and mocks. Do not commit API
keys, credentials, private documents, recordings, account exports, or live
provider responses. Live provider smoke tests are opt-in, privately configured,
never run in default CI, and must not consume paid quota without separate
authorization.

## Local checks

Use the pinned package manager and lockfile:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit --audit-level=high
```

See [CI quality gates](docs/ci-quality-gates.md) for the secret-scanning and
dependency-audit remediation process, including a safe failing sample that
never commits a credential.
