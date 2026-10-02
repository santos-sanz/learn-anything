# Convex development lifecycle

## Supported setup

Use Node 22+ and the repository's pinned pnpm 10.20.0. Install with `pnpm install`; Convex 1.43.0, `convex-test` 0.0.60 and its Edge Runtime peers are exact versions in `packages/api/package.json` and `pnpm-lock.yaml`.

Run `pnpm --filter @learn-anything/api convex:dev` from the repository root (equivalent to `npx convex dev` in `packages/api`). It attaches only a development deployment, pushes checked-in schema/functions and generates `packages/api/convex/_generated/` typed bindings. Generated bindings are ignored: a fresh checkout regenerates them with `pnpm --filter @learn-anything/api convex:codegen` after install.

## Synthetic reset and migration checks

Automated tests never call Convex or the network; they use in-memory `convex-test`. Run the reset twice and compatibility/retry checks with:

```sh
pnpm test -- packages/api/tests/schema-lifecycle.test.ts
pnpm test -- packages/api/tests/schema-lifecycle.test.ts
```

Bootstrap first records a cursor, then a retry writes one version marker and completes. `checkCompatibility` requires the committed schema and function versions. Future data changes must be additive/optional, ship a bounded indexed resumable internal migration with a cursor, test retry and old/new compatibility, then tighten fields only after completion. Do not use SQL migrations or unbounded `.collect()` in production functions.

## Deployment and secrets boundary

`packages/api/.env.local` is local-only and ignored by the root `.gitignore`; `packages/api/.env.example` is the committed empty template. Convex CLI writes development coordinates locally. Production is separately selected and explicitly deployed with `convex deploy` only when separately authorized; development variables do not become production variables. Deployment-admin credentials and provider keys are server-side per deployment and never imported by `packages/app` or exposed through `VITE_*` values.

## Plan and operational limits

The selected plan is **Convex Free**, never metered Starter. Checked limits: 0.5 GB database, 1 GB/month database I/O, 1 GB file storage, 1 GB/month data egress, 0.5 GB search storage, 3,000 query-GB/month search and 1 million function calls/month. Reconfirm actual plan and current limits at any authorized provisioning/deployment; quota exhaustion must fail visibly and must not trigger paid upgrade. Roll back a failed release by redeploying the previous compatible commit; do not downgrade a populated schema until data compatibility is assessed.
