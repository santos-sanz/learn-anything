# CI quality gates

The GitHub Actions **Quality gates** workflow runs on every pull request and
push to `main`. It uses Node.js 22.14.0, which satisfies the workspace's
`engines.node` pin (`22.x`, also the Node line Vercel builds on; see
`vercel.json` and `docs/deployment-runbook.md` section 13), sets up pnpm 10.20.0, and installs the
locked dependency graph with `pnpm install --frozen-lockfile`.

## What runs

- **Lint, types, tests, and build:** `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  and `pnpm build` run from a clean checkout.
- **Secret scan:** Gitleaks scans repository history and checked-out content.
  A finding fails the `Secret scan` job.
- **Dependency audit:** `pnpm audit --audit-level=high` fails the dependency
  audit job for high- or critical-severity advisories.

These jobs do not deploy, call a provider API, use provider API keys, or create
paid resources. They use GitHub-hosted runners and public actions only.

## Remediating a failure

Never paste a detected secret into an issue, pull request, log, or test
fixture. Revoke or rotate a real credential immediately, remove it from the
working tree and repository history as appropriate, then confirm Gitleaks
passes in a new run. A false positive needs a narrowly justified, reviewed
Gitleaks allowlist entry; do not broadly disable scanning.

For a dependency advisory, identify the affected dependency with `pnpm audit`,
upgrade it or a safe parent dependency, refresh the lockfile deliberately, and
run all quality commands. If no safe remediation exists, document the advisory,
scope, mitigation, owner, and review date in the issue; do not suppress it just
to make CI green.

## Safe deliberately-failing secret-scan proof

Use a disposable untracked file with a clearly fake sentinel value; do not use
a real credential and do not commit the file:

```sh
sample_file="$(mktemp ./gitleaks-sample.XXXXXX)"
fake_prefix='github_pat_11AA'
fake_suffix="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 82)"
printf '%s%s\n' "$fake_prefix" "$fake_suffix" > "$sample_file"
gitleaks detect --no-git --source "$sample_file" --redact
sample_status=$?
rm -f "$sample_file"
test "$sample_status" -ne 0
```

The Gitleaks command must exit non-zero for the sentinel, proving the detector
can block a matching pattern. The final cleanup and `test` preserve that failure
as successful test evidence without leaving a secret-like file in the worktree.
Install Gitleaks from its official release instructions if it is not available
locally; GitHub Actions supplies it in CI through `gitleaks/gitleaks-action`.
