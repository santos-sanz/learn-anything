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

Project deletion is two phase: `requestProjectDeletion` soft-deletes the root immediately, then bounded `deleteProjectBatch` calls hard-delete child records before hard-deleting the project. The batch is safe to retry and rejects a project that was not first soft-deleted by its owner. S04 covers messages, sessions, goals and progress events; S08 extended the same protocol to documents, ingestion jobs, `privateFiles` rows and their storage blobs, so a deleted project leaves no document bytes behind. Chunks (S10) and citations (S13) must extend the same protocol when they are introduced.

Schema/function markers are installed by resumable bootstrap migrations. The current `bootstrapSchemaV4` upgrades a completed `bootstrap-schema-v2` or `bootstrap-schema-v3` run in place; it has no backfill because those markers only added tables and the v4 `documents`/`ingestionJobs` tables start empty. Rollback means redeploying the compatible earlier release only before the new functions are in use, while a populated deployment must remain on a compatible release until a separately tested migration exists.

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

## S08 document uploads and metadata

Schema/function version 4 adds `documents` and `ingestionJobs`. A document repeats `ownerId` and `projectId`, points at its S05 `privateFiles` row and `_storage` id, and carries `filename`, `extension`, `contentType`, `sizeBytes`, `status` (`pending` | `ready` | `failed`), a non-content `failureCode` and the client's `idempotencyKey`. `documents.by_owner_project_idempotency` scopes retry deduplication to one owner/project, and `ingestionJobs.by_document` is the exactly-one-job guard; S09 owns execution states, leases and retries, so S08 only queues `queued` jobs and surfaces status.

`POST /private-uploads?projectId=<id>&filename=<name>&idempotencyKey=<key>` is the authenticated upload action. It derives identity from `ctx.auth`, validates parameter shapes, re-checks project ownership before the body is read, enforces the size limit from the declared `Content-Length` and the measured byte length, requires the declared media type to match the extension (`application/pdf` for `.pdf`, `text/markdown` for `.md`/`.markdown`, `text/plain` for `.txt`), and sniffs content before anything is saved: PDFs need a `%PDF-` header and a `%%EOF` marker, text must decode as UTF-8 without NUL bytes. The limit comes from the `MAX_UPLOAD_BYTES` deployment variable: empty, malformed or non-positive values fall back to the 10 MiB product cap and no configuration can exceed `10485760`, keeping every request below the 20 MiB HTTP-action ceiling.

Bytes are stored only through `storeWithRollback`: the transactional `commitDocumentUpload` mutation re-checks ownership, then writes the `privateFiles` row, the `documents` row and exactly one queued `ingestionJobs` row together, while an already-seen `idempotencyKey` resolves to the committed document. Any blob the commit does not keep (rejection, replay or failure) is deleted immediately, so no orphan survives a failed upload.

Downloads never use `storage.getUrl`: `/private-files/:fileId` re-derives identity on every request, re-checks owner and project internally, and returns bytes with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. `listDocuments`/`getDocument` return status metadata only — no bytes, no storage ids, no URLs. Upload rejections and storage failures surface as typed codes (`FILE_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `UNSUPPORTED_CONTENT`, `QUOTA_EXCEEDED`, `UPLOAD_FAILED`, non-enumerating `NOT_FOUND`) without content.

Offline tests: `packages/api/tests/document-uploads.test.ts` and `upload-contract.test.ts` cover synthetic fixtures, configured size limits, MIME/extension/content rejection before saving, orphan cleanup, idempotent replay with exactly one job, pending/failed/ready status without content leakage, and anonymous plus two-user negative upload/download paths; `schema-lifecycle.test.ts` covers the v4 marker, its retry and v2/v3 upgrades. Migration: run `bootstrapSchemaV4` before the new functions are used; it has no backfill. Rollback: redeploy the previous compatible release only while no v4 document rows exist, otherwise keep a release compatible with the populated schema. Operational limits: one request carries at most one file under the cap; per-actor quotas, rate limits and privacy lifecycle belong to S24, ingestion execution to S09.

## S15 microphone STT HTTP path

`POST /stt/transcribe?projectId=&language=&turnId=` accepts raw audio bytes and returns `{ turnId, text, language, duration }`. The browser authenticates with `useAuthToken()` as `Authorization: Bearer <access token>`; the handler re-derives identity with `requireUserId`, re-checks project ownership through the internal `stt.authorizeSttProject` query, and answers non-enumerating `401 UNAUTHENTICATED` / `404 NOT_FOUND` before any provider work. Identity or ownership never comes from the request body.

The route drives the S11 `NanClient` from `packages/worker/src/nan` through a source-relative import (ADR-0003 places provider work at the worker/action boundary; `packages/worker` itself is unchanged). Configuration: `NAN_API_KEY` (required, server-side only; missing → `503 STT_NOT_CONFIGURED`), `NAN_DEPLOYER_ID` (the single-user policy gate; empty or non-matching learner → `403 PROVIDER_POLICY_BLOCKED`, so a personal key never serves another learner), and `STT_TIMEOUT_MS` (optional, default 15000; tests set a small value). Failures map to observable statuses: `429 + retryAfterMs`, `502 upstreamStatus 524`, `504` timeout, `499` cancelled, `422 SILENCE`, `413`, `415`.

Audio bytes are request-scoped: they are never written to `ctx.storage` or any table, and the client discards its buffered recording after processing or on abort. Limits: 8 MiB request cap (below Convex's 20 MiB HTTP ceiling and NaN's 25 MiB cap), compressed `audio/webm|ogg|mp4` only, no browser or CI transcoding, and no `/audio/translations` calls for ordinary transcription. S15 adds no schema tables and no version-marker bump of its own (the markers carry the current release's value, v4 after S08): the addition is an additive internal query plus an HTTP route, and rollback is a plain code rollback. `convex/_generated/api.d.ts` was updated to the exact codegen output for the new `stt` module because offline `npx convex codegen` requires a configured deployment; regenerate and commit it on the next `npx convex dev`.

## Plan and operational limits

The selected plan is **Convex Free**, never metered Starter. Checked limits: 0.5 GB database, 1 GB/month database I/O, 1 GB file storage, 1 GB/month data egress, 0.5 GB search storage, 3,000 query-GB/month search and 1 million function calls/month. Reconfirm actual plan and current limits at any authorized provisioning/deployment; quota exhaustion must fail visibly and must not trigger paid upgrade. Roll back a failed release by redeploying the previous compatible commit; do not downgrade a populated schema until data compatibility is assessed.
