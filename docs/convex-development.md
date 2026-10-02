# Convex development lifecycle

## Supported setup

Use Node 22+ and the repository's pinned pnpm 10.20.0. Install with `pnpm install`; Convex 1.43.0, `convex-test` 0.0.60 and its Edge Runtime peers are exact versions in `packages/api/package.json` and `pnpm-lock.yaml`.

Run `pnpm --filter @learn-anything/api convex:dev` from the repository root (equivalent to `npx convex dev` in `packages/api`). It attaches only a development deployment, pushes checked-in schema/functions and regenerates `packages/api/convex/_generated/` typed bindings. The generated bindings are committed because the offline CI typecheck and `convex-test` suite need them without deployment credentials; regenerate and commit their diff whenever Convex functions or schema change.

## Synthetic reset and migration checks

Automated tests never call Convex or the network; they use in-memory `convex-test`. Run the reset twice and compatibility/retry checks with:

```sh
pnpm test -- packages/api/tests/schema-lifecycle.test.ts packages/api/tests/projects.test.ts
pnpm test -- packages/api/tests/schema-lifecycle.test.ts packages/api/tests/projects.test.ts
```

Bootstrap first records a cursor, then a retry writes one version marker and completes. `checkCompatibility` requires the committed schema and function versions. Future data changes must be additive/optional, ship a bounded indexed resumable internal migration with a cursor, test retry and old/new compatibility, then tighten fields only after completion. Do not use SQL migrations or unbounded `.collect()` in production functions.

## S04 project and conversation schema

Schema/function version 2 adds `projects`, `learningGoals`, `learningSessions`, `messages`, and `progressEvents`. Document, ingestion-job, and chunk tables are deliberately deferred to S08/S09/S10: they are not placeholders in this release because their storage, upload and retry contracts are not ready. A project is the root scope (its Convex `_id` is its `projectId`); every child record repeats `ownerId` and `projectId`, and mutations verify both the referenced project and session before writing.

`projects.by_owner` supports an owner's project list. Each child table's `by_owner_project` supports its scoped list and bounded cleanup; sessions add `by_owner_project_session_key` for idempotent session creation; messages add `by_owner_project_session`, `by_owner_project_turn`, and `by_owner_project_idempotency` for a session transcript, stable turn lookup, and retry deduplication. `turnId` and `idempotencyKey` are client-generated stable opaque strings; `createdAt`, `endedAt`, and `deletedAt` are generated inside Convex mutation handlers with the server's `Date.now()`, never accepted from the caller.

S04 exports internal-only example mutations while S05/S06 establish `ctx.auth` identity. Their explicit `actorUserId` is a testable server-caller contract, not a public authorization path; no public function is exposed that trusts it. S05 must replace the placeholder with `ctx.auth.getUserIdentity()` and retain the ownership checks.

Project deletion is two phase: `requestProjectDeletion` soft-deletes the root immediately, then bounded `deleteProjectBatch` calls hard-delete messages, sessions, goals, and progress events before hard-deleting the project. The batch is safe to retry and rejects a project that was not first soft-deleted by its owner. No document data exists in S04; S08/S10 must extend the same protocol explicitly for documents, jobs, chunks, and citations.

Schema/function markers are installed by resumable bootstrap migrations. The current `bootstrapSchemaV3` upgrades a completed `bootstrap-schema-v2` run in place; it has no backfill because v1 had no business rows and the v3 change only adds tables. Rollback means redeploying the compatible earlier release only before the new functions are in use, while a populated deployment must remain on a compatible release until a separately tested migration exists.

## Deployment and secrets boundary

## S05 authorization and private-file boundary

All public functions derive `ownerId` from `ctx.auth` through Convex Auth's `getAuthUserId` (the user half of the `userId|sessionId` subject, so a session change never rewrites ownership); no public argument may supply an owner. Each record read or mutation verifies both its `ownerId` and the requested `projectId`, returning typed `UNAUTHENTICATED` or non-enumerating `NOT_FOUND` errors. `privateFiles` is a generic S05 ownership registry only (S08 owns document parsing and ingestion): `/private-files/:fileId` derives HTTP identity, performs an internal owner/project recheck, then returns bytes with `Cache-Control: private, no-store`; it never returns `storage.getUrl()` because that URL is bearer access.

Tenant caches are keyed `ownerId:projectId:<operation>:<version>` and must never cache an unscoped result. S12/S13 vector search is not implemented here; its contract is to apply owner/project filter fields in the vector query, then re-fetch/recheck every hit against authenticated ownership before using it.

`packages/api/.env.local` is local-only and ignored by the root `.gitignore`; `packages/api/.env.example` is the committed empty template. Convex CLI writes development coordinates locally. Production is separately selected and explicitly deployed with `convex deploy` only when separately authorized; development variables do not become production variables. Deployment-admin credentials and provider keys are server-side per deployment and never imported by `packages/app` or exposed through `VITE_*` values.

## S06 authentication and verified agent sessions

Convex Auth 0.0.96 (beta) is the identity layer; ADR-0004 records the method selection. Password sign-in is registered unconditionally, GitHub/Google OAuth only when both client credentials for that provider exist as deployment variables, and no email provider is registered at all, so OTP, magic-link, email verification and password reset are unavailable until an email provider is configured. `convex/auth.config.ts` binds `ctx.auth` verification to this deployment's `/.well-known/jwks.json`; `JWT_PRIVATE_KEY` and `JWKS` are generated per deployment and only empty placeholders live in the root `.env.example`.

Sessions are pinned: 1 hour RS256 access JWT, 30 day total and inactive session duration, refresh-token rotation on use. The web client wraps the app in `ConvexAuthProvider`, maps `useConvexAuth()` state to loading/sign-in/workspace (an expired session renders the sign-in form), and its sign-out handler revokes outstanding agent connection tokens before calling Convex Auth `signOut`. Redirect targets after OAuth or a magic link are checked by `convex/redirects.ts`: exact matches against `AUTH_REDIRECT_URIS` plus `SITE_URL`, no wildcards, failing closed.

`agentConnectionTokens` (schema/function version 3) implements the S07 handshake contract. Issue requires an authenticated owner and a live project; only the SHA-256 of the 256-bit token is stored, bound to `ownerId + projectId`, with a default 300 second and maximum 900 second TTL. `POST /agent/connection-tokens/verify` and `POST /agent/connection-tokens/reconnect` (also the internal `verifyConnectionToken` mutation for server callers) reject forged (`CONNECTION_TOKEN_INVALID`), expired (`CONNECTION_TOKEN_EXPIRED`), revoked or rotated-and-replayed (`CONNECTION_TOKEN_REVOKED`) and out-of-scope (`CONNECTION_TOKEN_SCOPE`) tokens; reconnect rotates, so the presented token becomes a rejected replay. Cloudflare hosting of the agent runtime itself remains S07.

Offline tests: `packages/api/tests/auth.test.ts`, `auth-callback.test.ts`, `redirects.test.ts`, `agent-sessions.test.ts`, plus the UI view/form tests in `packages/app/tests`. The OAuth tests install an intercepting `fetch` and assert zero outbound requests; ordinary CI performs no network calls. Rollback: redeploy the previous release while the deployment still has no version 3 rows beyond additive tables, or clear the OAuth/email credentials to disable those methods without a code change.

## S21 project dashboard, goal/mode selection

Schema/function version 4 is additive: `projects` gains optional `goal` (trimmed free text) and `mode` (`language-practice` | `concept-learning`). Existing v3 rows stay valid and read as unset, so `bootstrapSchemaV4` has no backfill; it only re-stamps `schemaMetadata` (4 → compatible, older → upgrade, newer → rejected), and `packages/api/tests/schema-lifecycle.test.ts` covers clean reset, retry, v2/v3 → v4 upgrades and downgrade rejection.

Function changes in `packages/api/convex/projects.ts` (identity still comes only from `ctx.auth` via S05/S06 `requireUserId`):

- `createProject` accepts optional `goal`/`mode`; `name` is required, trimmed and capped at 100 characters, `goal` at 500.
- `listProjects` and the new `getProject` return `{ _id, name, goal?, mode?, createdAt }`; `getProject` is owner-only and non-enumerating (`UNAUTHENTICATED`/`NOT_FOUND`).
- `updateProject({ projectId, name?, goal?, mode? })` requires at least one field; an empty `goal` clears the selection, an omitted field is left unchanged. `mode` has no clear path yet (documented limit). Deletion keeps the S04 two-phase protocol: the app calls `requestProjectDeletion` once, then bounded `deleteProjectBatch(limit: 100)` until `completed`.

`packages/app` grows the S21 screens: a hash router (`#/projects`, `#/projects/new`, `#/projects/:id`), `ProjectsProvider` with explicit loading/error/retry list state, Dashboard/NewProject/ProjectDetail screens, a shared labelled `ProjectForm`, and a native-`<dialog>` delete confirmation. The data port (`makeConvexProjectsBackend`) issues promise-based Convex calls, so list freshness comes from explicit reloads after mutations rather than live reactivity; every failure maps to fixed, safe copy through `mapDataError` (no backend message is interpolated). Anonymous visitors never reach the shell: `Root` renders the S06 sign-in view and leaves any deep link intact for after sign-in.

Provider configuration stays server-side: the app reads only `VITE_CONVEX_URL` (plus Vite's own `DEV` flag), asserted by `packages/app/tests/no-provider-secrets.test.ts`, which also pins the empty `.env.example` files and the responsive viewport/CSS. `src/preview.tsx` is a DEV-only fixture renderer for local screenshot evidence; `import.meta.env.DEV` folds to `false` in `vite build`, so preview code and synthetic data never ship (verify with `VITE_CONVEX_URL=… pnpm --filter @learn-anything/app build` then grep `dist/` for `preview-`).

## Plan and operational limits

The selected plan is **Convex Free**, never metered Starter. Checked limits: 0.5 GB database, 1 GB/month database I/O, 1 GB file storage, 1 GB/month data egress, 0.5 GB search storage, 3,000 query-GB/month search and 1 million function calls/month. Reconfirm actual plan and current limits at any authorized provisioning/deployment; quota exhaustion must fail visibly and must not trigger paid upgrade. Roll back a failed release by redeploying the previous compatible commit; do not downgrade a populated schema until data compatibility is assessed.
