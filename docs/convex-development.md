# Convex development lifecycle

## Supported setup

Use Node 22+ and the repository's pinned pnpm 10.20.0. Install with `pnpm install`; Convex 1.43.0, `convex-test` 0.0.60 and `@edge-runtime/vm` are exact versions in `packages/api/package.json` and `pnpm-lock.yaml`. (The unused `@edge-runtime/jest-environment` pin was removed with the S12 dependency remediation: it only existed to pull Jest 29 internals that carried the unfixed `braces` advisory, nothing referenced it, and `convex-test` does not peer on it.)

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

Project deletion is two phase: `requestProjectDeletion` soft-deletes the root immediately, then bounded `deleteProjectBatch` calls hard-delete child records before hard-deleting the project. The batch is safe to retry and rejects a project that was not first soft-deleted by its owner. The soft-delete step is idempotent for its owner: re-running it on an already soft-deleted project it owns succeeds instead of returning `NOT_FOUND`, so an interrupted, failed or capped cleanup resumes from the records that are still there, while anonymous and foreign callers keep the non-enumerating `UNAUTHENTICATED`/`NOT_FOUND` errors. S04 covers messages, sessions, goals and progress events; S08 extended the same protocol to documents, ingestion jobs, `privateFiles` rows and their storage blobs, so a deleted project leaves no document bytes behind. Chunks (S10) and citations (S13) must extend the same protocol when they are introduced.

Schema/function markers are installed by resumable bootstrap migrations. The current `bootstrapSchemaV6` upgrades a completed `bootstrap-schema-v2` through `bootstrap-schema-v5` run in place; its v6 step backfills the S09 job fields in bounded indexed batches (see S09 below), version 5 only added optional `goal`/`mode` fields to `projects` that read as unset without a backfill, and earlier markers only added tables that started empty. Rollback means redeploying the compatible earlier release only before the new functions are in use, while a populated deployment must remain on a compatible release until a separately tested migration exists.

## Deployment and secrets boundary

## S05 authorization and private-file boundary

All public functions derive `ownerId` from `ctx.auth` through Convex Auth's `getAuthUserId` (the user half of the `userId|sessionId` subject, so a session change never rewrites ownership); no public argument may supply an owner. Each record read or mutation verifies both its `ownerId` and the requested `projectId`, returning typed `UNAUTHENTICATED` or non-enumerating `NOT_FOUND` errors. `privateFiles` is a generic S05 ownership registry only (S08 owns document parsing and ingestion): `/private-files/:fileId` derives HTTP identity, performs an internal owner/project recheck, then returns bytes with `Cache-Control: private, no-store`; it never returns `storage.getUrl()` because that URL is bearer access.

Tenant caches are keyed `ownerId:projectId:<operation>:<version>` and must never cache an unscoped result. S12/S13 vector search is not implemented here; its contract is to apply owner/project filter fields in the vector query, then re-fetch/recheck every hit against authenticated ownership before using it.

`packages/api/.env.local` is local-only and ignored by the root `.gitignore`; `packages/api/.env.example` is the committed empty template. Convex CLI writes development coordinates locally. Production is separately selected and explicitly deployed with `convex deploy` only when separately authorized; development variables do not become production variables. Deployment-admin credentials and provider keys are server-side per deployment and never imported by `packages/app` or exposed through `VITE_*` values.

## S06 authentication and verified agent sessions

Convex Auth 0.0.96 (beta) is the identity layer; ADR-0004 records the method selection. Password sign-in is registered unconditionally, GitHub/Google OAuth only when both client credentials for that provider exist as deployment variables, and no email provider is registered at all, so OTP, magic-link, email verification and password reset are unavailable until an email provider is configured. `convex/auth.config.ts` binds `ctx.auth` verification to this deployment's `/.well-known/jwks.json`; `JWT_PRIVATE_KEY` and `JWKS` are generated per deployment and only empty placeholders live in the root `.env.example`.

Sessions are pinned: 1 hour RS256 access JWT, 30 day total and inactive session duration, refresh-token rotation on use. The web client wraps the app in `ConvexAuthProvider`, maps `useConvexAuth()` state to loading/sign-in/workspace (an expired session renders the sign-in form), and its sign-out handler revokes outstanding agent connection tokens before calling Convex Auth `signOut`. Redirect targets after OAuth or a magic link are checked by `convex/redirects.ts`: exact matches against `AUTH_REDIRECT_URIS` plus `SITE_URL`, no wildcards, failing closed.

`agentConnectionTokens` (schema/function version 3) implements the S07 handshake contract. Issue requires an authenticated owner, a full Convex Auth session subject (`userId|sessionId` — an identity that carries only an email address or only a user id is rejected with typed `UNAUTHENTICATED` before any row is written, so no record can be bound to a partial identity) and a live project; only the SHA-256 of the 256-bit token is stored, bound to `ownerId + projectId`, with a default 300 second and maximum 900 second TTL. `POST /agent/connection-tokens/verify` and `POST /agent/connection-tokens/reconnect` (also the internal `verifyConnectionToken` mutation for server callers) take the token alone — any `ownerId`, `userId`, `email` or `projectId` field in the request body is ignored — and reject forged (`CONNECTION_TOKEN_INVALID`), expired (`CONNECTION_TOKEN_EXPIRED`), revoked or rotated-and-replayed (`CONNECTION_TOKEN_REVOKED`) and out-of-scope (`CONNECTION_TOKEN_SCOPE`) tokens; reconnect rotates, so the presented token becomes a rejected replay. Cloudflare hosting of the agent runtime itself remains S07.

Offline tests: `packages/api/tests/auth.test.ts`, `auth-callback.test.ts`, `redirects.test.ts`, `agent-sessions.test.ts` and `auth-negative-tokens.test.ts` (missing, forged, malformed and expired access tokens denied with typed `UNAUTHENTICATED` codes across projects, sessions, files, tutor, retrieval, TTS and the authenticated HTTP routes, each with a verified-token positive control), plus the UI view/form tests in `packages/app/tests` and the handshake tests in `packages/agent/tests`. The OAuth tests install an intercepting `fetch` and assert zero outbound requests; ordinary CI performs no network calls. Rollback: redeploy the previous release while the deployment still has no version 3 rows beyond additive tables, or clear the OAuth/email credentials to disable those methods without a code change.

## S08 document uploads and metadata

Schema/function version 4 adds `documents` and `ingestionJobs`. A document repeats `ownerId` and `projectId`, points at its S05 `privateFiles` row and `_storage` id, and carries `filename`, `extension`, `contentType`, `sizeBytes`, `status` (`pending` | `ready` | `failed`), a non-content `failureCode` and the client's `idempotencyKey`. `documents.by_owner_project_idempotency` scopes retry deduplication to one owner/project, and `ingestionJobs.by_document` is the exactly-one-job guard; S09 owns execution states, leases and retries, so S08 only queues `queued` jobs and surfaces status.

`POST /private-uploads?projectId=<id>&filename=<name>&idempotencyKey=<key>` is the authenticated upload action. It derives identity from `ctx.auth`, validates parameter shapes, re-checks project ownership before the body is read, enforces the size limit from the declared `Content-Length` and the measured byte length, requires the declared media type to match the extension (`application/pdf` for `.pdf`, `text/markdown` for `.md`/`.markdown`, `text/plain` for `.txt`), and sniffs content before anything is saved: PDFs need a `%PDF-` header and a `%%EOF` marker, text must decode as UTF-8 without NUL bytes. The limit comes from the `MAX_UPLOAD_BYTES` deployment variable: empty, malformed or non-positive values fall back to the 10 MiB product cap and no configuration can exceed `10485760`, keeping every request below the 20 MiB HTTP-action ceiling.

Bytes are stored only through `storeWithRollback`: the transactional `commitDocumentUpload` mutation re-checks ownership, then writes the `privateFiles` row, the `documents` row and exactly one queued `ingestionJobs` row together, while an already-seen `idempotencyKey` resolves to the committed document. Any blob the commit does not keep (rejection, replay or failure) is deleted immediately, so no orphan survives a failed upload.

Downloads never use `storage.getUrl`: `/private-files/:fileId` re-derives identity on every request, re-checks owner and project internally, and returns bytes with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. `listDocuments`/`getDocument` return status metadata only — no bytes, no storage ids, no URLs. Upload rejections and storage failures surface as typed codes (`FILE_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `UNSUPPORTED_CONTENT`, `QUOTA_EXCEEDED`, `UPLOAD_FAILED`, non-enumerating `NOT_FOUND`) without content.

Offline tests: `packages/api/tests/document-uploads.test.ts` and `upload-contract.test.ts` cover synthetic fixtures, configured size limits, MIME/extension/content rejection before saving, orphan cleanup, idempotent replay with exactly one job, pending/failed/ready status without content leakage, and anonymous plus two-user negative upload/download paths; `schema-lifecycle.test.ts` covers the marker migration (advanced to `bootstrapSchemaV6` by S09), its retry, its bounded backfill and v2/v3/v4/v5 upgrades. Migration: run the current bootstrap migration before the new functions are used (S09: `bootstrapSchemaV6`). Rollback: redeploy the previous compatible release only while no v4 document rows exist, otherwise keep a release compatible with the populated schema. Operational limits: one request carries at most one file under the cap; per-actor quotas, rate limits and privacy lifecycle belong to S24, ingestion execution to S09.

## S21 project dashboard, goal/mode selection

Schema/function version 5 was additive on top of S08's version 4: `projects` gains optional `goal` (trimmed free text) and `mode` (`language-practice` | `concept-learning`). Existing rows stay valid and read as unset, so its original `bootstrapSchemaV5` marker had no backfill; S09's `bootstrapSchemaV6` supersedes that marker for the same release (the replace-the-marker step S08 took for versions 2/3), re-stamps `schemaMetadata` and covers v5 -> v6 adoption, while `packages/api/tests/schema-lifecycle.test.ts` still covers clean reset, retry, v2/v4 -> v5-era upgrades and downgrade rejection.

Function changes in `packages/api/convex/projects.ts` (identity still comes only from `ctx.auth` via S05/S06 `requireUserId`):

- `createProject` accepts optional `goal`/`mode`; `name` is required, trimmed and capped at 100 characters, `goal` at 500.
- `listProjects` and the new `getProject` return `{ _id, name, goal?, mode?, createdAt }`; `getProject` is owner-only and non-enumerating (`UNAUTHENTICATED`/`NOT_FOUND`).
- `updateProject({ projectId, name?, goal?, mode? })` requires at least one field; an empty `goal` clears the selection, an omitted field is left unchanged. `mode` has no clear path yet (documented limit). Deletion keeps the S04 two-phase protocol: the app calls `requestProjectDeletion` (idempotent, safe to re-run after a failure), then bounded `deleteProjectBatch(limit: 100)` until `completed`; `NOT_FOUND` on either step can only mean the project row is already hard-deleted, which the data port treats as a completed deletion instead of an error, and an exhausted batch cap surfaces `DELETION_INCOMPLETE` as a retryable error rather than hiding the project.

`packages/app` grows the S21 screens: a hash router (`#/projects`, `#/projects/new`, `#/projects/:id`), `ProjectsProvider` with explicit loading/error/retry list state, Dashboard/NewProject/ProjectDetail screens, a shared labelled `ProjectForm`, and a native-`<dialog>` delete confirmation. The data port (`makeConvexProjectsBackend`) issues promise-based Convex calls, so list freshness comes from explicit reloads after mutations rather than live reactivity; every failure maps to fixed, safe copy through `mapDataError` (no backend message is interpolated). Anonymous visitors never reach the shell: `Root` renders the S06 sign-in view and leaves any deep link intact for after sign-in.

Provider configuration stays server-side: the app reads only `VITE_CONVEX_URL` (plus Vite's own `DEV` flag), asserted by `packages/app/tests/no-provider-secrets.test.ts`, which also pins the empty `.env.example` files and the responsive viewport/CSS. `src/preview.tsx` is a DEV-only fixture renderer for local screenshot evidence; `import.meta.env.DEV` folds to `false` in `vite build`, so preview code and synthetic data never ship (verify with `VITE_CONVEX_URL=… pnpm --filter @learn-anything/app build` then grep `dist/` for `preview-`).

## S09 ingestion job runner

Schema/function version 6 adds S09 lease/retry fields to `ingestionJobs` and the `documentChunks` table, following S21's version 5. The new job columns are optional and additive (`maxAttempts`, `leaseOwner`, `leaseExpiresAt`, `nextAttemptAt`, `failureCode`, `contentVersionKey`, `chunkCount`) so an S08-era row still validates; two indexes are added: `by_status` (`status`) and `by_status_next` (`status`, `nextAttemptAt`). `documentChunks` repeats `ownerId`/`projectId`, keys every row by (`documentId`, `chunkKey`) where `chunkKey` = `${contentVersionKey}#${seq}` and `contentVersionKey` = `<sha256(content)>:v<contract version>`, and stores `text`, `contentHash` and a `locator` (`blockIndex`, `page`, `heading`). `documents.status` keeps the S08 `pending`/`ready`/`failed` surface; job-level `unsupported` is an extra terminal job state, surfaced on the document as `failed` with a specific `failureCode`.

Migration: `bootstrapSchemaV6` is resumable and bounded — the first call records the run, each later call backfills `nextAttemptAt` for at most 100 jobs in `by_document` order and stores the cursor, and the final call writes the version marker. Run `npx convex run migrations:bootstrapSchemaV6` until it returns `completed: true`; an interrupted batch that replays is a no-op. Rows missing `nextAttemptAt` remain claimable through `by_status` until the backfill runs, so the runner never depends on the migration having completed.

Runner contract: `crons.ts` schedules `internal.ingestion.runIngestionCycle` every five minutes (one bounded internal call per interval, sized against Convex Free's 1 million function calls/month). The cycle claims at most 10 jobs (default 5) through `claimNextJob`, which first sweeps up to 10 `running` jobs whose lease expired — back to `queued` and immediately ready while attempts remain, otherwise to the `failed` dead letter with `LEASE_EXPIRED` — then claims the earliest eligible `queued` job by patching `status`/`attempts`/`leaseOwner`/`leaseExpiresAt` in one transaction. That patch is the linearization point: concurrent workers cannot take the same job, and a worker whose lease rotated away is rejected by `LEASE_LOST`/`JOB_NOT_RUNNING` on `completeJob`, `recordFailure` and `markUnsupported`. Attempt budget defaults to 5 with 30 s doubling backoff (cap 15 min) and a 120 s lease; `INGESTION_MAX_ATTEMPTS`, `INGESTION_BACKOFF_BASE_MS`, `INGESTION_LEASE_MS` and `INGESTION_PARSE_TIMEOUT_MS` are validated and clamped, never trusted. Retryable failures (`PARSE_TIMEOUT`, `PARSE_FAILED`, `STORAGE_MISSING`, conflicts) requeue with backoff until the budget is spent, then dead-letter; deterministic input problems (encrypted PDF, image-only/scanned PDF, unsupported media, malformed or oversized input, no extractable text) go straight to `unsupported` and are never retried.

Parsing runs inside the Convex action (ADR-0002), never in an HTTP request: `/private-uploads` only queues. Only the fixed PDF/Markdown/plain-text parsers in `packages/worker/src/ingestion` run, with no eval, no dynamic code and no embedded-document execution; time and memory safeguards (10 MiB input, 4M output characters, 2,000 blocks, default 10 s parse timeout) stop extraction while it walks. The pluggable process step (`ProcessStep` in `packages/worker/src/ingestion/process.ts`) is keyed by the content version: its `chunkKey`/`seq` are validated server-side, a replayed run keeps identical rows (`fresh: 0`), same-key-different-content fails `CHUNK_CONFLICT`, and an older contract generation is replaced. S09 shipped a trivial default that emitted one chunk per extracted block; S10 fills the same seam with `sourceAwareProcessStep`, documented under S10 below.

Offline tests: `packages/worker/tests/ingestion.test.ts` covers the parser fixtures (including encrypted and image-only PDFs, deflate streams, determinism, safeguards and the no-evaluator scan) and `packages/api/tests/ingestion-jobs.test.ts` covers claim exclusivity, lease expiry/resume without duplicates, stale-worker rejection, backoff into a dead letter, unsupported states, run-twice idempotency with identical chunk rows, S08-era row compatibility, owner-scoped status and configuration clamps. Migration/rollback: the v6 columns are invisible to readers that never touch them, but a populated v6 deployment (rows with S09 fields or `documentChunks` rows) must stay on a compatible v6+ release until a separately tested downgrade exists; roll back only before such rows exist. Operational limits: claim scans a 25-row eligible window and a 10-row lease window per call, at most 10 jobs per cycle, at most 2,000 chunks per document, at most 10 attempts per job; queue depths or document sizes beyond those bounds fail visibly rather than silently.
## S10 source-aware chunking

No schema, validator or public-function change: `SCHEMA_VERSION`/`FUNCTION_VERSION` stay 6 and the bootstrap marker stays `bootstrap-schema-v6`, so there is no migration to run. What changes is the ingestion contract: `INGESTION_CONTRACT_VERSION` moves from 1 to 2, so `contentVersionKey` becomes `<sha256(content)>:v2`. A document re-ingested under S10 therefore writes a fresh generation — `commitChunks` upserts the v2 rows and deletes any v1 rows of the same document — instead of colliding with S09's one-chunk-per-block output; documents already `succeeded` under v1 keep their rows until they are ingested again.

`sourceAwareProcessStep` (packages/worker/src/ingestion/process.ts) implements the S10 half of the S09 `ProcessStep` seam. Consecutive extraction blocks that share a source region — the same `page` for PDFs, the same heading path for Markdown — are joined with `\n\n` and windowed to `size` characters with `overlap` characters carried into the next window; windows never cross a region boundary, so each chunk's locator is exactly the region it starts in: `page` (one-based PDF page), `heading` (the full Markdown path joined with ` > `, e.g. `Chapter one > Section alpha`, null for PDFs and plain text) and `blockIndex` (the block the window starts in). The Markdown parser now tracks heading levels so `# A` followed by `## A1` records `A > A1`. Embedding and vector fields are deliberately absent: S12 owns the index and S13 owns retrieval.

Configuration: `INGESTION_CHUNK_SIZE` (default 1000, accepted 64..8000) and `INGESTION_CHUNK_OVERLAP` (default 100) are read by `configuredChunkSize`/`configuredChunkOverlap` and re-validated by `resolveChunkConfig`: a malformed or sub-minimal size falls back to the default, an oversized size clamps down to 8000, a non-integer/negative overlap falls back to 100, and any overlap that would reach the size clamps to `size - 1`, so the window step is always positive. Measured bounds the tests assert instead of assuming: every chunk is at most `size` characters (the first window of a region reaches it when the region is longer), consecutive chunks inside a region share at least `min(overlap, next chunk length)` characters, a window containing only whitespace is dropped so an empty chunk never becomes a row (skips leave no `seq`/`chunkKey` gap), and a document that would yield more than 2,000 chunks fails with the terminal `OUTPUT_TOO_LARGE` code instead of producing rows `commitChunks` would refuse. Ordering is the region order of the document, so identical input always reproduces byte-identical rows (`seq`, `chunkKey`, `text`, `contentHash`, locator) and a replay converges on the same `_id`s.

Document text stays data, never instruction: chunk drafts and stored rows have a fixed field set, document bytes appear only in `text` and in locator metadata values, the `commitChunks` validator rejects any extra field a caller attempts to add (`Unexpected field`), and `listIngestionJobs` carries status metadata only. Hostile fixtures (instruction-override phrases, fake system/tool markers, UI-mimicking Markdown) ingest exactly like benign ones and are stored verbatim as inert strings.

Offline tests: `packages/worker/tests/chunking.test.ts` covers documented defaults and configuration validation, a long fixture crossing many windows under two configurations against an independent window oracle with measured lengths/overlaps, nested heading paths, a three-page PDF with page-marker attribution, empty/whitespace input, the adversarial fixture with its fixed field set, the 2,000-chunk cap, and replay determinism. `packages/api/tests/chunking.test.ts` drives the runner end to end with the environment configuration: measured sizes/overlaps on stored rows, coarse-vs-fine row counts for identical bytes, run-twice idempotency with identical row ids, stored PDF page attribution, stored heading paths, adversarial rows plus the validator rejection and a content-free status surface, and blank input ending `unsupported` with zero rows. Synthetic fixtures only: `long-lesson.txt`, `nested-headings.md`, `adversarial-instructions.md`, `blank.txt`, `three-page-lesson.pdf`; no provider, embedding or network call exists in this path.

Migration/rollback: nothing to backfill; v1 rows remain readable and are replaced only when their document ingests again. Treat the chunk configuration as a deployment constant: changing `INGESTION_CHUNK_SIZE`/`INGESTION_CHUNK_OVERLAP` while a document's job already committed rows under the previous value makes that replay fail visibly with `CHUNK_CONFLICT` (same keys, different text) until the job dead-letters, rather than silently mixing window generations. Operational limits: at most 2,000 chunks per document (with the default window that is about 1.8M characters, below the 4M parse output cap), chunk size bounded to 64..8000 characters, overlap below size, and — as before — 10 jobs per cycle and 10 attempts per job.

## S15 microphone STT HTTP path

`POST /stt/transcribe?projectId=&language=&turnId=` accepts raw audio bytes and returns `{ turnId, text, language, duration }`. The browser authenticates with `useAuthToken()` as `Authorization: Bearer <access token>`; the handler re-derives identity with `requireUserId`, re-checks project ownership through the internal `stt.authorizeSttProject` query, and answers non-enumerating `401 UNAUTHENTICATED` / `404 NOT_FOUND` before any provider work. Identity or ownership never comes from the request body. An unexpected failure of the ownership query is `500 INTERNAL_ERROR`, not a client `400`: only identity (`401`), authorization (`403`), missing ownership (`404`) and malformed ids (`400`) are reported as caller-visible statuses.

This is the first browser call to the `.convex.site` origin in this codebase, so the route owns an explicit CORS contract in `convex/cors.ts`: `Authorization` plus an `audio/*` content type always triggers a preflight, and `OPTIONS /stt/transcribe` answers `204` with `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: Authorization, Content-Type` and `Access-Control-Max-Age: 86400` while reading no credentials at all; every real `POST` response — success, denial or failure — carries `Access-Control-Allow-Origin` plus `Vary: origin`. Convex adds neither the preflight nor the headers for you ([HTTP actions → CORS](https://docs.convex.dev/functions/http-actions#cors), the same pattern as Convex's own HTTP demos). The allowed origin is derived only from deployment configuration — the origin of `SITE_URL` plus the origins of `AUTH_REDIRECT_URIS`, never a wildcard and never `Access-Control-Allow-Credentials` — so an origin outside that allowlist is not echoed back. Offline coverage: `packages/api/tests/cors.test.ts` proves the anonymous preflight, the allow-origin header on a real response, the allowlist origins, and the negative case for a foreign origin.

The route drives the S11 `NanClient` from `packages/worker/src/nan` through a source-relative import (ADR-0003 places provider work at the worker/action boundary; `packages/worker` itself is unchanged). Configuration: `NAN_API_KEY` (required, server-side only; missing → `503 STT_NOT_CONFIGURED`), `NAN_DEPLOYER_ID` (the single-user policy gate; empty or non-matching learner → `403 PROVIDER_POLICY_BLOCKED`, so a personal key never serves another learner), and `STT_TIMEOUT_MS` (optional, default 15000; tests set a small value). Failures map to observable statuses: `429 + retryAfterMs`, `502 upstreamStatus 524`, `504` timeout, `499` cancelled, `422 SILENCE`, `413`, `415`.

Audio bytes are request-scoped: they are never written to `ctx.storage` or any table, and the client discards its buffered recording after processing or on abort. Limits: 8 MiB request cap (below Convex's 20 MiB HTTP ceiling and NaN's 25 MiB cap), compressed `audio/webm|ogg|mp4` only, no browser or CI transcoding, and no `/audio/translations` calls for ordinary transcription. S15 adds no schema tables and no version-marker bump of its own (the markers carry the current release's value, v6 after S09): the addition is an additive internal query plus an HTTP route, and rollback is a plain code rollback. `convex/_generated/api.d.ts` was updated to the exact codegen output for the new `stt` and `cors` modules because offline `npx convex codegen` requires a configured deployment (it refuses to run without `CONVEX_DEPLOYMENT`, and without access to that project); regenerate and commit it on the next `npx convex dev`.


## S18 explicit translation

Two authenticated, project-scoped HTTP actions join the S15 route, and both reuse `internal.stt.authorizeSttProject`, `cors.ts` and the S11 `NanClient`: `POST /translation/audio?projectId=&turnId=&target=` with raw audio bytes, and `POST /translation/text?projectId=` with `{ text, source, target }`. Both preflight `OPTIONS` through `corsPreflightRoute`, so the browser contract (`Authorization` + `Content-Type`, allowlist from `SITE_URL`/`AUTH_REDIRECT_URIS`) is identical to `/stt/transcribe`. Identity still comes only from `ctx.auth`, ownership is re-checked before any provider work, and audio bytes stay request-scoped: neither route writes to `ctx.storage` or to any table.

Whisper's translation endpoint outputs English only, so `target` on the audio route is validated before the body is read: any value other than `en` answers `422 AUDIO_TRANSLATION_UNSUPPORTED` with `supportedTargets: ["en"]` and `fallback: "text-translation"`, and the provider is never contacted — the UI turns that into "audio translation to X is not supported; we can translate the text instead". The adapter also refuses to relabel a non-English answer: `NanClient.translateAudioToEnglish` throws `NAN_MALFORMED_RESPONSE` unless the response reports English, so a misbehaving provider cannot become a silent English result either. The route returns `{ turnId, text, language: "en", target: "en" }`.

`POST /translation/text` accepts only the S11 typed language set (`en`, `es`): an unknown `source`/`target` is `422 UNSUPPORTED_LANGUAGE_PAIR` with `supportedLanguages`, an empty text is `400`, over 20000 characters is `413 TEXT_TOO_LARGE`, and `source === target` answers `200 { unchanged: true }` without a provider call. The LLM task lives in `packages/worker/src/nan/translation.ts`: the system instruction is a pure function of the validated pair (never of the source), the source travels JSON-encoded in the user message as `kind: "untrusted-source-text"`, and `parseTranslationUserMessage` recovers it byte-for-byte. Instructions written inside the source therefore can only ever be data, and offline evaluation asserts that the system instruction for an injection fixture is byte-identical to a benign one.

Configuration reuses `NAN_API_KEY` and `NAN_DEPLOYER_ID` (same single-user policy gate and same `403 PROVIDER_POLICY_BLOCKED`), plus optional `TRANSLATION_TIMEOUT_MS` (default 15000, mirroring the S11 quota). Failures map to `TRANSLATION_TIMEOUT` (504), `TRANSLATION_RATE_LIMITED` (429 + `retryAfterMs`), `TRANSLATION_PROVIDER_UNAVAILABLE`/`TRANSLATION_BAD_PROVIDER_RESPONSE`/`TRANSLATION_PROVIDER_REJECTED`/`TRANSLATION_PROVIDER_ERROR` (502), `CANCELLED` (499), `TEXT_TOO_LARGE`/`AUDIO_TOO_LARGE` (413) and `TRANSLATION_NOT_CONFIGURED` (503); S15's STT codes are unchanged, because the mapper now takes an explicit scope.

Offline tests: `packages/api/tests/translation.test.ts` (Whisper English-output contract against a mocked adapter, unsupported-combination fallbacks, two-user isolation, policy and typed limits, CORS preflight), `packages/worker/tests/translation-eval.test.ts` with `tests/fixtures/translation-pairs.json` (reviewed synthetic bilingual pairs, meaning preservation and injection resistance), `packages/worker/tests/translation-prompt.test.ts` (prompt isolation, delimiter smuggling, English-only audio contract), and the UI suites in `packages/app/tests`. Nothing performs a live NaN/Whisper/LLM call in CI. S18 adds no schema table and no version-marker bump: rollback is a plain code rollback, and `convex/_generated/api.d.ts` gained the new `translation` module entry by hand for the same reason as S15 (offline `npx convex codegen` needs a configured deployment).

## S12 vector search and the 4096-dimension spike

**The dimensional contradiction is resolved in favour of 4096.** The spike ran
on 2026-10-03 against the existing FREE dev deployment
(`andres-sanz:learn-anything-8b91f:dev/issue-7-s03`, `https://charming-duck-160.convex.cloud`)
with the pinned SDK/CLI `convex@1.43.0`:

- `npx convex dev --once` accepted a schema containing
  `.vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 4096, filterFields: [...] })`
  and printed `✔ Convex functions ready!`; the index diff line for the
  4096-dimension index was
  `chunkEmbeddings.by_embedding (vector)   embedding (4096 dimensions), filters on ownerId, projectId`.
- A production `searchProjectVectors` call with a real 4096-float query vector
  returned ranked rows with `_score` values from the live ANN index (scores
  0.0466..0.0324 top-5 for the recorded sample query). The guide's stated range
  (2–4096) is what the platform enforces; the generated `VectorIndexConfig`
  API-reference note of 2–2048 is stale doc-comment text in the pinned SDK
  (it compiles into `dimensions: number` with no runtime check at that bound).
- Denial paths on the deployment, in order: anonymous → `UNAUTHENTICATED`
  (before retrieval), cross-owner project → `NOT_FOUND` (before retrieval),
  3-wide query vector → `VECTOR_DIMENSION_INVALID` (after authorization, before
  retrieval), `limit: 51` → `INVALID_ARGUMENT`.
- Platform probe: a raw 2048-wide row inserted *around* the typed mutation was
  accepted into the table (the platform excludes wrong-width rows from the
  index instead of rejecting the document), which is exactly why
  `commitEmbeddings` rejects wrong widths itself with
  `EMBEDDING_DIMENSION_MISMATCH` — storage never accepts them.

`convex-test` (0.0.60) emulates vector search with brute-force cosine and does
**not** enforce index dimensions, so offline tests prove the authorization,
filter, recheck, ordering and rejection logic while the deployment spike is the
only evidence for the platform limit itself.

### Schema and query contract

`chunkEmbeddings` stores one row per current-version chunk:
`ownerId`, `projectId`, server-derived `scopeKey` (`"ownerId:projectId"`),
`documentId`, `chunkId`, `contentVersionKey`, `seq`, `model`, `modelVersion`,
`dimensions`, `embedding: v.array(v.float64())`, `embeddedAt`. The index
declares `dimensions: 4096` and `filterFields: ["ownerId", "projectId", "scopeKey"]`.
Convex vector filter expressions expose only `q.eq`/`q.or` (no AND), so the
single `scopeKey` equality is what binds owner AND project *before* retrieval;
`ownerId`/`projectId` remain declared filterFields and are re-enforced on every
hit by `recheckSearchHits` (owner, project, chunk existence and content version)
before anything is returned as context.

`searchProjectVectors` (action) orders its work: authentication → project
ownership (`NOT_FOUND` for foreign/deleted) → query-vector width/finite checks
→ filtered `ctx.vectorSearch` → per-hit ownership recheck. Typed errors:
`UNAUTHENTICATED`, `NOT_FOUND`, `VECTOR_DIMENSION_INVALID`, `VECTOR_MALFORMED`,
`INVALID_ARGUMENT`. Storage-side typed errors from `commitEmbeddings`:
`EMBEDDING_MODEL_MISMATCH`, `EMBEDDING_DIMENSION_MISMATCH`, `EMBEDDING_MALFORMED`,
plus scope errors `NOT_FOUND`/`JOB_NOT_RUNNING`/`CONTENT_VERSION_CONFLICT`.
The ingestion action embeds through the S11 adapter (batches ≤ 32 inputs and
≤ 24,000 joined characters), failing the job visibly with codes such as
`EMBEDDING_NOT_CONFIGURED`, `NAN_POLICY_BLOCKED` or `NAN_MALFORMED_RESPONSE`
instead of skipping retrieval setup.

### Quota, benchmark and operational limits

Each vector search is billed the **full index size in query-GB regardless of
filters or result count** (Convex docs "Costs"), so tenant filters protect
scope, not per-tenant billing. The benchmark corpus was 550 synthetic
4096-dimensional rows (500 + 50 across two synthetic tenants):

- Raw vector bytes: 550 × 4096 × 8 B = 18,022,400 B ≈ 0.018 GB → about
  166,000 searches per Free month (3,000 query-GB) on a raw-byte basis; the
  platform's measured index size (ANN overhead) is larger and is what actually
  bills — recheck it in the dashboard's search storage before relying on the
  arithmetic.
- Search-storage ceiling: 0.5 GB ÷ 32 KiB ≈ 16,384 vectors raw — roughly
  1,000 documents at a typical ~15 chunks, far fewer for 500+ chunk documents.
  Exhaustion must fail visibly, never trigger a paid upgrade.
- Benchmark on the deployment through the production action (100 rounds,
  synthetic topic centroids, gold = same-topic chunks):
  **recall@10 = 0.99, p50 = 18.8 ms, p95 = 137.8 ms, p99 = 203.7 ms,
  mean = 30.9 ms, max = 368.3 ms, 0 failures**. Latency is measured in-action
  around `ctx.runAction(searchProjectVectors)` and therefore excludes CLI/HTTP
  client overhead.
- A single function execution may read at most **16 MiB**, which 500+ 32 KiB
  vectors exceed; every embedding-touching path is windowed accordingly
  (`commitEmbeddings` ≤ 32 vectors/commit, stale sweep ≤ 100 rows/call,
  `deleteProjectBatch` rows ≤ 100 per call).
- NaN's `qwen3-embedding` documents 60 RPM and a batch size of 32; the
  embedding stage batches within both, and provider failures surface as typed
  job failure codes on the normal retry/dead-letter path.

### Migration and rollback

Schema/function version 7 adds only the new (initially empty) `chunkEmbeddings`
table and index; its marker migration is an adoption that keeps the idempotent
`nextAttemptAt` backfill for pre-v6 deployments. The dev deployment currently
reports `foundSchemaVersion: null`, so run the current marker
(`npx convex run internal.migrations.bootstrapSchemaV12 '{}'`, see S19/S20/S22 below)
after deploying to make `checkCompatibility` pass. Rollback is a code rollback: older
releases ignore the new table, no rows carry old-only data, and no backfill has
to be reversed; the vector index can be removed by pushing a schema without it
once no release queries it.

## S13 scoped retrieval, reranking and citation contract

No schema, validator or public-function change: `SCHEMA_VERSION`/`FUNCTION_VERSION` stay 7 and the bootstrap marker stays `bootstrap-schema-v7`, so there is no migration to run (citations are computed at retrieval time; S14 stores its own references, S22 renders them). Rollback is a plain code rollback — nothing backfilled, nothing to reverse, and a populated deployment keeps the same compatible v7 release. As with S15/S18, `convex/_generated/api.d.ts` gained the `retrieval` module entry by hand because offline `npx convex codegen` needs a configured deployment.

### Public surface

`retrieveProjectContext` (action, `packages/api/convex/retrieval.ts`) is the only public retrieval entry point. It authenticates through S05 `requireUserId`, authorizes the project through the shared `authorizeSearchScope` query (`NOT_FOUND` for a foreign, deleted or soft-deleted project before any retrieval), and takes **no owner argument**: identity and scope are always server-derived, so a request carrying crafted `ownerId`/`scopeKey` fields fails argument validation. Arguments: `projectId`, `query` (1..4,000 characters), `vector` (the embedded 4096-finite-float query — retrieval itself never calls a provider), optional `topK` (1..50, default 8), optional `rerank`, optional `minScore`, optional `maxContextChars` (1..24,000, default 6,000) and `maxContextTokens` (1..6,000, default `ceil(chars/4)`). Typed errors: `UNAUTHENTICATED`, `NOT_FOUND`, `VECTOR_DIMENSION_INVALID`, `VECTOR_MALFORMED`, `INVALID_ARGUMENT`.

The result is a discriminated union. `status: "ok"` carries `citations` (rank, `documentId`, `chunkId`, `seq`, `contentHash`, `page`, `heading` path, similarity `score`, `relevanceScore` when rerank ran, `inContext`), `missingSources`, a bounded `context` (`segments` with text plus `chars`/`estimatedTokens`), `rerank` and `diagnostics` (`candidates`, `minScore`, `bestScore`). `status: "insufficient-evidence"` carries a machine-readable `reason` — `EMPTY_CORPUS` (index has no rows in scope), `NO_CANDIDATES` (rows existed but none survived the recheck), `LOW_CONFIDENCE` (best score at or below `minScore`) or `CONTEXT_BUDGET_EXHAUSTED` (not even the top chunk fits) — plus the same `missingSources`, `rerank` and `diagnostics`, so a vanished source is reported instead of silently dropped and an answer context is never fabricated from nothing.

### Filter-vs-recheck contract

What the **platform filters**: `ctx.vectorSearch` runs with one `q.eq` on the server-derived `scopeKey = "ownerId:projectId"`, because Convex vector filter expressions expose only `q.eq`/`q.or` and no AND combinator; the candidate set the index can return is constrained to this tenant pair before any hit comes back. `ownerId`/`projectId` remain declared `filterFields` so the conjunction stays expressible field by field if the platform later ships `and()`.

What **we enforce** (authoritative, per hit, in `internal.retrieval.classifyRetrievalHits`): the embedding row, its chunk and its document are re-fetched and must all belong to the authenticated owner AND the requested project, the chunk must point at the row's document, the content versions must match, and the document must be `ready`. An ownership failure (including a row forged into someone else's `scopeKey`) is **dropped without appearing anywhere in the result** — not even its identifiers leak as a "missing" report. An embedding row deleted in the window between `vectorSearch` and this recheck is dropped the same way: with the row already gone its ownership can no longer be verified, so it appears neither as a citation nor as a missing source. Ownership that holds while the source is unusable (chunk deleted, document deleted, document not ready, superseded content version) is **reported as a `missingSources` entry** with the identifiers still known and no text. A citation is therefore never built from a row the filter did not constrain and the recheck did not confirm.

### Determinism

Fixed inputs give fixed outputs, test-locked twice per scenario: candidates are re-sorted by score descending with chunk id as the tie-break; the optional rerank is the pure `resolveRerankOrder` decision (`packages/worker/src/nan/rerank.ts`); top-k is a fixed slice of that order; the budget then packs whole chunks greedily in the same order (`chars + next <= budget`, tokens estimated as `ceil(chars/4)` per segment). Results contain no timestamps and no random ordering, so running the same retrieval twice returns byte-identical JSON.

### Rerank routing, provider limits and fallbacks

Rerank is optional and uses the S11 NaN `/rerank` adapter (`NanClient.rerank`) behind the same single-user policy gate; ordinary CI and all tests mock `fetch` and never touch the network or paid quota. The rerank pool is exactly the top-k candidates in similarity order — candidates ranked below top-k are never citable, so rerank reorders the citation set instead of promoting out-of-scope rows into it. The pool applies when `query + joined candidate texts` fits NaN's documented 24,000-character input quota (at the defaults: 8 candidates × 1,000-character S10 chunks + query ≈ 9,000 characters, comfortably inside; a large `topK` of 8,000-character chunks will not fit and falls back visibly). Every non-success path falls back to the original similarity order with a **visible reason** in the result — never another provider, never a retry, never randomness: `not-configured` (no `NAN_API_KEY`), `single-candidate`, `input-too-large` (the joined pool exceeds the quota, checked *before* any request), `policy-blocked` (a personal key may not serve a learner who is not the deployer), `rate-limited`, `timeout`, `cancelled`, `unsupported`, `malformed-response` (including out-of-range or duplicate indices) and `provider-error`. When rerank is requested but evidence never reaches the step (empty corpus, no candidates, low confidence) the result reports `not-attempted`, so no provider call is wasted on a corpus that cannot support an answer.

### Confidence gate and operational limits

A candidate counts as evidence only when its score is strictly above `minScore`: the per-call argument, else the `RETRIEVAL_MIN_SCORE` deployment variable (malformed values fall back to the default), else `MIN_SCORE_DEFAULT = 0`. The default is deliberately conservative: `RETRIEVAL_MIN_SCORE` calibration is pending observation of the platform's score scale — S12's live spike recorded same-topic scores around 0.03..0.05, so operators should set `RETRIEVAL_MIN_SCORE` from dashboard observations rather than assume cosine units. Limits: one vector search per retrieval billed at the **full index size in query-GB regardless of filters or result count**, at most `min(topK * 4, 50)` candidates fetched per call, at most 50 citations, context bounded by both budgets (24,000 characters hard cap, below NaN's input quota), and chunk text ≤ 8,000 characters per the S10 window so a single execution stays far below Convex's 16 MiB read ceiling.

### Offline test evidence

`packages/api/tests/retrieval.test.ts` (17 tests) covers the citation contract (ids, page, heading path, content hash), two-user isolation (anonymous/foreign/crafted-scope denial, forged `scopeKey` and foreign `ownerId` rows dropped with no identifier leak), two-project isolation (sibling chunks never returned, forged project scope not widening retrieval), gold-question relevance fixtures (`tests/fixtures/retrieval-gold.ts` + `helpers/textVectors.ts`, deterministic synthetic term vectors; each project seeds eight chunks against `topK: 3`, and the test asserts the gold chunk is retrieved *and ranks exactly 1* ahead of the topical distractors, with `diagnostics.candidates` pinned to the fixture size so the corpus cannot shrink back inside top-k), empty-corpus and low-confidence explicit results (argument, environment and default thresholds), deleted chunk/document, not-ready document and superseded-version missing-source reporting, `NO_CANDIDATES` when every source vanished, run-twice determinism, char/token budget enforcement plus `CONTEXT_BUDGET_EXHAUSTED`, rerank applied through a mocked `/rerank`, all rerank fallback reasons (including provider limits costing no request), argument validation and provider-free retrieval. `packages/worker/tests/rerank.test.ts` (8 tests) covers the pure ordering/fallback decision: tie-breaks, unreturned candidates, quota pre-check, typed-error mapping, malformed payloads and five-run determinism. No live NaN/LLM call exists anywhere in `pnpm test`.

## S14 grounded tutor session/turn orchestration

Schema/function version 8 adds two empty, additive tables on top of S12/S13's version 7: `tutorTurns` and `citations`. `bootstrapSchemaV8` (renamed forward by every later story, same replace-the-marker step every version bump takes) is a marker-only adoption that keeps the idempotent `nextAttemptAt` backfill so a pre-v6 deployment is not skipped — run `npx convex run internal.migrations.bootstrapSchemaV12 '{}'` (the current marker, which supersedes V8/V9/V10) after deploying this release so `checkCompatibility` passes. Rollback is a code rollback while both tables are empty; a populated v8 deployment (turn rows or stored citations) must stay on a compatible v8+ release until a separately tested downgrade exists. `citations` and `tutorTurns` join the S04 two-phase deletion protocol in `deleteProjectBatch`, so a deleted project leaves no turn or citation rows behind. As with S15/S18, `convex/_generated/api.d.ts` gained the `tutor` module entry by hand because offline `npx convex codegen` needs a configured deployment.

### Public surface and order of operations

`runTurn` (action, `packages/api/convex/tutor.ts`) takes `{ projectId, turnId, text, sessionKey?, rerank? }` and runs a fixed order: authentication (`requireUserId`) → project ownership (`authorizeTurnScope`, non-enumerating `NOT_FOUND` before any row or provider request) → argument validation (`turnId` 1..128 non-control characters, text 1..4,000 characters, otherwise `INVALID_ARGUMENT`/`TEXT_TOO_LARGE`) → idempotent session resolution → `beginTurn` → NaN client resolution (`TURN_NOT_CONFIGURED` when `NAN_API_KEY` is empty; no other provider is ever constructed) → query embedding → S13 `retrieveProjectContext` (top-k 8, 6,000-character context, optional rerank) → `recordRetrieval` → prompt build → streamed completion with bounded retries → `commitTurn`. The S11 single-user policy gate still applies (`NAN_DEPLOYER_ID`), so a personal key never serves a learner who is not the deployer.

The read/cancel surface: `cancelTurn({ projectId, turnId })` → `{ status: "cancelled" | "already-cancelled" | "already-completed" | "failed" }`; `getTurn` (owner-only state: status, attempts, failure code, evidence, answer basis); `getTranscript({ projectId, sessionId?, limit? })` (≤200 messages per page, oldest first, with re-validated citations and a `droppedCitations` count). Internal functions (`ensureSession`, `beginTurn`, `recordRetrieval`, `failTurn`, `commitTurn`, `readTurnResult`, `getTurnStatus`, `recentHistory`) keep the S04 server-caller contract with an explicit `ownerId`: they are not public, and the public path always derives identity from `ctx.auth`.

### Idempotency and cancellation semantics

`beginTurn` is the linearization point per `(ownerId, projectId, turnId)`: the first request inserts the `running` row with an attempt token and a 60-second lease; a retry observes `completed` (and replays the stored result through `readTurnResult` — no provider call, `replayed: true`), `cancelled`, `failed`, or `in-progress` (a live lease), and only an expired lease is taken over with a fresh token. `commitTurn` refuses anything but `running` under the same token (`TURN_ATTEMPT_LOST` otherwise), so a stale attempt can never write a second message set; message idempotency keys are `"<turnId>:learner"` / `"<turnId>:tutor"`.

`cancelTurn` flips `running` → `cancelled` and never rewrites a finished turn. The action observes cancellation in three places: a watcher polls `getTurnStatus` every `TURN_CANCEL_POLL_MS` (default 1 s, clamped 20..10,000 ms) and aborts the in-flight provider request, `recordRetrieval` throws `TURN_CANCELLED` at that stage boundary, and `commitTurn` re-checks the status. Because the learner message, the tutor message and their citations are inserted in **one** mutation that only runs while the row is `running`, a cancelled turn leaves zero messages and zero citations — no partial or duplicate transcript.

### Citations: write-time validation and rendering re-check

`retrievedChunkIds` freezes the chunk ids that scoped retrieval returned for this attempt (defense-in-depth: `recordRetrieval` rechecks owner/project/document for each). `commitTurn` then rejects, before any write: a `chunkId` outside that set, a chunk or document that no longer exists in this owner/project, or a non-`ready` document → `CITATION_NOT_RETRIEVED`; duplicates or >50 citations → `CITATION_INVALID`. `documentId`/`seq`/`contentHash`/`page`/`heading` are copied from the verified chunk row, never from the caller, so an invented id can only ever describe an owned, retrieved chunk. Model output contributes only bracketed markers (`[n]`, canonical, deduplicated); markers outside the evidence range are dropped and reported as `unresolvedMarkers`. Rendering re-checks each stored citation against the live chunk and document in `getTranscript` and drops anything that no longer resolves (`droppedCitations`), leaving the stored row untouched.

### Prompt contract, no-evidence path and injection resistance

The system instruction (`buildTutorSystemPrompt` in `packages/worker/src/tutor/prompt.ts`) is a pure function of the project's `goal`, `mode` and the turn's evidence mode — document text is not an input, so it is byte-identical for a hostile and a benign document with the same project settings. Everything untrusted (learner text, bounded history of 6 messages/2,000 characters, evidence passages ≤6,000 characters) travels in one JSON-encoded user envelope (`kind: "tutor-turn"`), so injection attempts round-trip as inert data. When retrieval returns `insufficient-evidence` (`EMPTY_CORPUS`, `NO_CANDIDATES`, `LOW_CONFIDENCE`, `CONTEXT_BUDGET_EXHAUSTED`), the turn still runs with an empty `evidence` array, `answerBasis` becomes `general-explanation`, and the stored answer is prefixed server-side with the fixed `NO_EVIDENCE_STATEMENT` (composed by us, not the model) before the model's guidance; with evidence, `answerBasis` is `document-backed` and citations are extracted from the answer's markers.

### Streaming, retries, provider limits

The answer is consumed through the S11 `streamTutor` (provider streaming, `stream: true` in the request) into a bounded buffer: above `16,000` characters the turn fails `TURN_ANSWER_TOO_LONG` instead of storing truncated text, and the turn's `AbortSignal` aborts the request. This is the documented bounded equivalent of client-visible streaming: Convex actions cannot push incremental text to the browser, so the complete text is committed atomically and client-facing streaming belongs to S17's conversation state machine. Retries (`TUTOR_MAX_ATTEMPTS`, default 3, clamped 1..5; `TUTOR_RETRY_BASE_MS`, default 250 ms) apply only to transient failures (`TURN_RATE_LIMITED` honouring `Retry-After`, `TURN_TIMEOUT`, `TURN_PROVIDER_ERROR`); policy blocks, unsupported capabilities, oversized input, malformed responses, cancellation and an empty answer fail immediately with their real code. Failures are stored on the turn row (`failureCode`) and returned typed — `TURN_NOT_CONFIGURED`, `TURN_TIMEOUT`, `TURN_RATE_LIMITED`, `TURN_CANCELLED`, `TURN_POLICY_BLOCKED`, `TURN_INPUT_TOO_LARGE`, `TURN_PROVIDER_UNSUPPORTED`, `TURN_PROVIDER_MALFORMED`, `TURN_PROVIDER_ERROR`, `TURN_ANSWER_TOO_LONG`, `TURN_IN_PROGRESS`, `TURN_ATTEMPT_LOST`, `CITATION_NOT_RETRIEVED`, `CITATION_INVALID`. There is no silent provider substitution: the only endpoints touched are NaN `/embeddings` and `/chat/completions`, and `TUTOR_TIMEOUT_MS` (default 15 s) bounds both. No external action tools or autonomous agents exist on this path; tutor modes (S19/S20) and the chat UI are deliberately out of scope.

### Offline test evidence

`packages/api/tests/tutor.test.ts` (10 tests) drives the whole action with a mocked NaN `fetch`: document-backed turns (stored messages, citations, system prompt, transcript render), the no-evidence path (explicit `NO_EVIDENCE_STATEMENT` + guidance + `EMPTY_CORPUS`), the injection fixture (system byte-identical across hostile/benign documents, document text only inside the JSON envelope, fabricated markers never stored, foreign project unreachable), write-time citation rejection (foreign, not-retrieved, duplicate, vanished chunk → typed codes with no partial write, then a clean commit), idempotent retries under one `turnId` (three calls, one message set, one provider request), cancellation (in-flight abort, `TURN_IN_PROGRESS` for a concurrent duplicate, zero messages, idempotent cancel semantics), two-user/two-project isolation (no rows, no provider calls, own-chunks-only citations), provider retry/exhaustion/missing-key failures with visible codes, and rendering-side re-validation. `packages/worker/tests/tutor-prompt.test.ts` (5 tests) covers prompt purity, envelope round-trip, marker extraction and the composed disclosure; `packages/worker/tests/tutor-turn.test.ts` (10 tests) covers the retry/cancellation/bounding policy and a mocked SSE stream through the real adapter. No live NaN/LLM call exists anywhere in `pnpm test`.

## S16 Kokoro speech synthesis and playback

No schema, validator or version-marker change: `SCHEMA_VERSION`/`FUNCTION_VERSION` stay at the release value (11 after S19 + S22 + S20) and the bootstrap marker of that release was `bootstrap-schema-v11` (renamed forward by S24 to `bootstrap-schema-v12`), so S16 added no migration of its own — it only adds functions and an HTTP route, never schema fields. The addition is one internal query, one public read, one HTTP route and the browser player; rollback is a plain code rollback (route, player and section revert together, nothing backfilled). As with S15/S18/S14, `convex/_generated/api.d.ts` gained the `tts` module entry by hand because offline `npx convex codegen` needs a configured deployment.

### Voice and language availability comes from provider configuration

`packages/worker/src/nan/speech.ts` is the single source of truth: `KOKORO_VOICES` derives from the S11 `nanVoices` defaults (`af_heart` → `en`, `ef_dora` → `es`), `TTS_LANGUAGES` is exactly the set of languages those voices speak, `MAX_SPEECH_TEXT_CHARS` is 20,000 (headroom under the S11 24,000-character input quota) and `speechCatalog()` publishes the visible contract (`model: "kokoro"`, `format: "mp3"`, voices, languages, cap). `resolveSpeechVoice({ language, voice })` returns either a validated pair or a typed refusal — `UNSUPPORTED_VOICE`, `UNSUPPORTED_LANGUAGE` or `VOICE_LANGUAGE_MISMATCH`, each carrying `supportedVoices`/`supportedLanguages`. Absent parameters resolve to configuration defaults (English/`af_heart`, or the language's own configured voice); a rejected value never falls back silently, and the catalog deliberately does **not** claim that every Whisper STT language has a TTS voice. `speechTextFromTutorAnswer` strips citation markers (`[2]`) from the spoken text only — the stored and displayed transcript stays complete.

### Authenticated HTTP delivery with access checked on every request

`POST /tts/synthesize?projectId=&turnId=&language=&voice=` (`convex/tts.ts`) synthesizes the stored tutor response of exactly one owned turn and streams MP3 bytes back. Order per request: identity from `ctx.auth` (`401`), parameter shape (`400`), then the internal `tts.resolveSpeechTarget` query re-checks project ownership and requires the `tutorTurns` row to be `completed` **and** a stored tutor message — foreign project, unknown turn, running/cancelled/failed turn and message-less turn are the same non-enumerating `404`, so a response that a cancellation removed can never be turned into audio. Voice/language validation (`422` with the configured lists), the 20,000-character cap (`413`), then the S11 `NanClient.speech` call behind the single-user policy gate (`403`) with `NAN_API_KEY` missing → `503 TTS_NOT_CONFIGURED`. Failures map through the shared scope with a `TTS` prefix: `429 TTS_RATE_LIMITED + retryAfterMs`, `504 TTS_TIMEOUT` (`TTS_TIMEOUT_MS`, default 15000), `502 TTS_PROVIDER_UNAVAILABLE` (524), `502 TTS_PROVIDER_ERROR`, `499 CANCELLED`. The route has no request body: the spoken text can only be the stored message the internal query returns, so the route cannot synthesize arbitrary text.

Bytes are never committed: the route calls neither `ctx.storage` nor any insert, never touches `storage.getUrl`, and answers `Cache-Control: private, no-store` + `X-Content-Type-Options: nosniff` (plus the shared CORS headers; `OPTIONS /tts/synthesize` preflights like the S15/S18 routes). `tts.speechOptions` (public query) returns the catalog to a signed-in learner only — it contains no provider key and no user data. The browser client (`packages/app/src/ttsClient.ts`) sends `Authorization: Bearer <useAuthToken()>` and maps statuses to fixed copy; a missing token never reaches the network.

### Player, autoplay and cancellation semantics

`packages/app` renders `TutorResponseSection` on the project detail screen: the complete tutor transcript, the `ResponsePlayer` (play/pause/resume/stop, language picker fed by `speechOptions`, status line, Retry after any failure) and a **Cancel turn** action while the project's latest turn (public `tutor.latestTurn` read, owner-only) is still `running`. The `ResponsePlayerController` keeps a monotonic generation token: `cancel()` (called first by Cancel turn, before `cancelTurn` runs), a Stop during loading, and a language change all bump it, abort the in-flight request, dispose the audio element and drop cached bytes — any continuation that observes an old generation is discarded, so audio that arrives after a cancellation is never played and never rewritten into the state. Autoplay is attempted when a response arrives; a browser `NotAllowedError` lands in the `autoplay-blocked` state, and the Play audio click is the user gesture that starts playback. The transcript is rendered outside the player state, so every failure keeps the full text visible next to its Retry action.

### Offline test evidence

`packages/api/tests/tts.test.ts` (17 tests, mocked NaN `fetch`): owner gets `audio/mpeg` bytes with no stored rows, `es` voice selection, anonymous `401`, cross-user `404`, unsupported voice/language/mismatch `422` with the configured lists and zero provider calls, cancelled/running/unknown turn `404` (stale audio rejected), missing message `404`, typed 429/502(524)/502, timeout 504, abort 499, missing key 503, deployer policy 403, oversize 413, malformed params 400, catalog query (+ anonymous denial) and the anonymous preflight; plus the owner-scoped `tutor.latestTurn` anchor. `packages/worker/tests/speech.test.ts` (7) covers the catalog, defaults, typed voice/language refusals, marker stripping, size guard and the exact `/audio/speech` payload. `packages/app/tests/response-player.test.tsx` (11) covers play/pause/resume/stop with the transcript always visible, blocked autoplay recovering through the Play audio gesture, synthesis failure → transcript + Retry, unsupported-voice copy, browser playback failure → transcript + Retry, anonymous/cross-user denials as typed failures, cancel-turn → late audio dropped with zero playback, stop-during-loading discarding late bytes, the configured language picker refetching in `es`, load failure/retry and the empty state; `player-state.test.ts` pins the reducer (a cancellation wins over every late event) and `tts-client.test.ts` the URL/status mapping. No live NaN/Convex/provider call exists anywhere in `pnpm test`, and no audio byte is committed to git.

## S19 language-practice tutor mode

Schema/function version 10 (the union of S19 and S22, which each originally shipped as an independent version 9 on its own branch — see S22 below; S16 merges in beside them with no schema or marker change of its own, so its TTS queries and HTTP route ship under this same v10 marker) adds one empty table and two additive validator changes on top of S14's version 8: `projects.languagePractice` (optional object with `targetLanguage` `en|es`, `level` `beginner|intermediate|advanced`, `correctionStyle` `immediate|end-of-turn`, `goals[]`, `roleplayScenarios[]`), a third `translation` member on `tutorTurns.answerBasis`, and the `practisedTopics` table (`ownerId`, `projectId`, `sessionId`, `turnId`, `topic`, `level`, `targetLanguage`, `createdAt`, indexed by `by_owner_project` and `by_owner_project_turn`). All three are optional/empty-start, so an S14-era row still validates with no backfill; `bootstrapSchemaV11` (renamed forward from V10/V9/V8 and again by S24 to V12, same replace-the-marker step every version bump takes; S20 unions its own additive scope into version 11 — `v11 = v10 (S19 union S22) union S20`) is a marker-only adoption that keeps the idempotent `nextAttemptAt` backfill — run `npx convex run internal.migrations.bootstrapSchemaV12 '{}'` after deploying this release so `checkCompatibility` passes (`foundSchemaVersion: 12` once the current marker has run). Rollback is a code rollback while `practisedTopics` is empty and no project carries `languagePractice`; a populated v10 deployment must stay on a compatible v10+ release until a separately tested downgrade exists. `practisedTopics` joins the S04 two-phase deletion protocol in `deleteProjectBatch`, so a deleted project leaves no practice history behind. As with S15/S18/S14, `convex/_generated/api.d.ts` gained the `languagePractice` module entry by hand because offline `npx convex codegen` needs a configured deployment.

### Mode configuration and the minimal S14 hook

`updateLanguagePracticeConfig({ projectId, config })` (mutation, `packages/api/convex/languagePractice.ts`) is the owner-only write; `config: null` clears it. Identity comes only from `ctx.auth`, ownership is re-checked, and the payload is re-validated by the S19 worker contract (`validateLanguagePracticeConfig`): enum fields must be from the typed sets, lists are capped at 5 goals / 5 roleplay scenarios with 200-character items (typed `INVALID_ARGUMENT` rejections before anything is stored). `getLanguagePracticeConfig` and `listPractisedTopics` are owner-only queries; anonymous and foreign callers get non-enumerating `UNAUTHENTICATED`/`NOT_FOUND`.

The S14 orchestrator changes are deliberately minimal: `authorizeTurnScope` now also returns the project's `languagePractice` settings, and `runTurn` chooses one of three prompts built by pure functions — the unchanged S14 `buildTutorSystemPrompt` (no config, or non-language modes), the S19 `buildLanguagePracticeSystemPrompt` (S14 prompt extended only with validated project settings: learning language with a reply-only rule, level directive, correction-style directive with short examples, goals, roleplay scenarios, and explicit prohibitions on certified-proficiency and text-based pronunciation claims), or the S18 translation task (below). Learner text and document text are never inputs to any system instruction, so the S14 injection contract is inherited: hostile and benign documents with the same project settings still produce byte-identical system messages, and untrusted data stays inside the JSON user envelope.

### Language retention and the explicit translation route

`detectTranslationRoute(learnerText, config)` (worker) is conservative: it needs an **addressed request framing** — an English/Spanish imperative or polite request at a sentence boundary (`Translate …`, `please translate …`, `Could you translate …`, `Traduce …`, `Tradúcelo …`, `Dilo en inglés`, `¿Puedes traducir …?`) — or a rendering question (`what does X mean in English`, `how do you say X in Spanish`, `¿Qué significa X en inglés?`), **and** a target-language cue: a named language (`into English`, `al español`) or, for an imperative only, a quoted payload; a rendering question without a named language never routes. The words `translate`/`translation`/`traducir` appearing anywhere else never qualify: a practice utterance (`I translate books every day`), a statement about the word itself (`The word translation is hard to spell`), a Spanish practice sentence (`Me gusta traducir canciones`) and a vocabulary/grammar question (`What does the tutor mean by subjunctive?`) all stay normal tutor turns, so the tutor replies in the chosen language unless the learner explicitly asks otherwise. Extractable source text (longest quoted segment, else the request with its wrapper stripped) is required as well; an empty remainder never routes. A routed turn skips embedding/retrieval (a translation cites nothing), records `recordRetrieval` with `insufficient-evidence` / reason `translation-request` for the cancellation stage-boundary check, and answers with `buildTranslationSystemPrompt`/`buildTranslationUserMessage` — the same S18 contract `/translation/text` uses — so translation never becomes a silent conversation-language switch. The stored answer is the translation verbatim (no `NO_EVIDENCE_STATEMENT` prefix; `answerKind: "translation"` in `commitTurn`), with `answerBasis: "translation"`, zero citations, and no practised-topic row (a translation request is not a practised topic). The target-language set is the S11/S18 typed set (`en`, `es`), so every routed pair is one S18 actually supports; there is no provider fallback.

### Practised-topic history (no proficiency claims)

After a successful commit of a configured language-practice tutor turn, `runTurn` calls the internal `recordPractisedTopic` mutation with a topic (the optional `practisedTopic` argument, else a normalised ≤120-character excerpt of the learner's own turn), the learner-selected `level` and `targetLanguage`. The write is idempotent per `(ownerId, projectId, turnId)` — a replayed turn never duplicates history — runs strictly after the committed result and is deliberately **non-fatal**: `recordPractisedTopic` still performs its own owner/session authorization, but any failure it raises is logged (`console.error`) and swallowed, so it can never roll back, mask or fail an already-committed turn. `level` and `targetLanguage` are typed twice — at the mutation arguments and in the `practisedTopics` schema validator — so a garbage value cannot enter history even through a direct write. The table and `listPractisedTopics` carry practice history only: there is no score, proficiency, certificate, achieved-level or pronunciation field in the schema, the query result or the prompt (whose every proficiency/pronunciation mention is phrased as a `- Never …` prohibition, asserted by tests). Text transcripts cannot support pronunciation scoring and none is computed anywhere in this path.

### Offline test evidence

`packages/worker/tests/language-practice-prompt.test.ts` (7 tests): S14 base inherited byte-for-byte and still a pure function of project settings; all 3 levels × 2 correction styles × 2 target languages yield pairwise-different system instructions with the level/correction directives present; both styles demand short examples with a corrected sentence; language-stays and never-switch wording; every proficiency/pronunciation mention is a prohibition; config validation/normalisation with typed rejections; topic derivation bounds. `packages/worker/tests/language-practice-eval.test.ts` (5 tests) drives reviewed synthetic beginner and intermediate dialogue fixtures (`tests/fixtures/language-practice-dialogues.json`) through a deterministic stand-in tutor that reads only the system instruction: immediate vs end-of-turn change correction placement (interleaved vs after the last learner turn), level changes reply behaviour on the same dialogue, all 12 level/style/language prompts are distinct, and neither prompts nor transcripts claim proficiency or pronunciation. `packages/worker/tests/language-practice-translation.test.ts` (7 tests): ordinary practice text in any language never routes; the four reviewed false positives (`I translate books every day`, `The word translation is hard to spell`, `Me gusta traducir canciones`, `What does the tutor mean by subjunctive?`) never route — each asserted against the pre-fix detector and failing there; explicit requests with a target-language cue still route in both supported language forms; quoted and wrapper-stripped explicit requests route to S18 with the expected source/target; the routed prompt is byte-identical to the S18 contract and pure across hostile/benign source text; the practice-language instruction is independent of learner text. `packages/api/tests/language-practice.test.ts` (9 tests) drives the real `runTurn` pipeline with a mocked NaN `fetch`: owner-validated configuration with anonymous/foreign denial; different level/style produce different provider prompts (byte-identical to the pure builder); language retention across learner texts; document injection cannot reach the language-practice system prompt (S14 citation contract still enforced); the explicit translation request path (S18 system/user contract, no embedding call, verbatim stored answer, `translation` basis, `translation-request` evidence, no topic row); topic recording (explicit and derived topics, idempotent replay, two-user/anonymous isolation, no proficiency fields in keys or values); typed history storage (allowed values enter, a garbage `level`/`targetLanguage` is rejected by the schema and by the write arguments); a failing history write after commit still returns the committed turn (regression: it used to surface `TURN_PROVIDER_ERROR`); concept-learning and unconfigured projects unchanged. `packages/api/tests/schema-lifecycle.test.ts` covers the v10 marker (clean reset, retry, newer-schema rejection, v8 S14-era adoption with readable pre-existing project/turn/document rows, no `languagePractice` property and no `deletedAt` tombstone, plus the historical v2–v7 upgrades). No live NaN/LLM call exists anywhere in `pnpm test`; provider traffic is the mocked `https://api.nan.builders/v1` fetch interceptor only.

### Operational limits

Configuration: at most 5 goals and 5 roleplay scenarios, 200 characters each; practised topics at most 120 characters; history queries at most 100 rows (default 50). Supported practice/translation languages are `en` and `es` until S18's typed set grows — an unsupported pair is rejected, never silently substituted. Translation-request detection is a documented heuristic (addressed request framing + target-language cue + extractable text); questions about translation as a topic, ordinary practice text and ambiguity stay normal tutor turns, and the separate S18 route remains available. A language-practice project without configuration falls back to the plain S14 prompt and records no topics. The prompt tells the model never to claim certification or score pronunciation from text; the platform itself computes no such score anywhere.
## S22 document management and citation source viewer

### Schema/function version 10 and migration (current marker: v12)

This branch added two purely additive structures as its own version 9:
`documents.deletedAt` (`v.optional(v.number())`, absent on every live row) as
the document deletion tombstone, and the `documentChunks.by_document_seq` index
the source viewer uses to load a cited chunk's bounded neighbours. No existing
row is touched. S19 then landed an independent version 9 (language-practice
config and `practisedTopics` history) on its own branch, so that merged release
shipped as **version 10**, and S20 subsequently unioned its own additive scope
on top as **version 11** — `v11 = v10 (S19 union S22) union S20`. The current
marker `bootstrapSchemaV12` (renamed forward from V11) adopts any older
deployment in place, superseding the `bootstrapSchemaV11`/`bootstrapSchemaV10`/`bootstrapSchemaV9`/`bootstrapSchemaV8` markers while
keeping the idempotent `nextAttemptAt` backfill so a pre-v6 deployment is not
skipped. Run `npx convex run internal.migrations.bootstrapSchemaV12 '{}'` after
deploying this release; `checkCompatibility` then reports
`foundSchemaVersion: 11`.
Rollback is a code rollback while no tombstones exist — older releases ignore
the optional field and never query the new index. A populated v8 deployment
that keeps tombstones should stay on a compatible release: pre-S22 code does
not filter `deletedAt`, so it would list a tombstone as a pending document.
As with S13, the `sources` module entry in `convex/_generated/api.d.ts` is
maintained by hand because offline `npx convex codegen` needs a configured
deployment.

### Public surface

- `documents.listDocumentStatuses` (query) joins each **live** document with
  its S09 job row (`status`, `attempts`, `maxAttempts`, `failureCode`,
  `nextAttemptAt`, `chunkCount`), bounded to the 200 most recent documents per
  project; tombstones are excluded, so the screen's badges are the real job
  state rather than an optimistic copy. `UNAUTHENTICATED` without identity,
  `NOT_FOUND` for a project the caller does not own.
- `documents.retryDocument` (mutation) re-arms a dead-lettered `failed` job
  (attempt budget reset to 0, `nextAttemptAt = now`, document back to
  `pending`) and is a **no-op** for `queued`/`running`/`succeeded`, so a double
  click or replayed request never creates a second job — `findOrCreateJob`'s
  `by_document` uniqueness is the underlying guard. `unsupported` is terminal
  by the S09 contract and returns `RETRY_NOT_ALLOWED`; a foreign, unknown or
  tombstoned document returns `NOT_FOUND`.
- `documents.deleteDocumentBatch` (mutation) mirrors the S04 two-phase
  protocol with `limit` ≤ 100: the first call stamps the tombstone and flips
  the document to `pending` (hiding it from every read surface and stopping a
  late settle from resurrecting it); each batch deletes the **job first** (an
  in-flight run then aborts before it can recreate chunks), then embeddings,
  then chunks, all through `by_document` indexes; only when none remain are
  the `privateFiles` row and the stored blob removed. The empty tombstone row
  stays so an already-issued citation resolves to the explicit
  `document-deleted` state, and it is swept with the project. Completion is
  reported as `{ completed: true }`; a repeat call is an idempotent no-op, and
  a foreign/unknown id is `NOT_FOUND`.
- `sources.getCitationSource` (query) takes `projectId`, `documentId` and an
  optional citation anchor (`chunkId`, `contentHash`) and returns either
  `{ status: "ok", document, focus, before, after }` (focus carries the chunk
  text, `seq`, `page`, `heading`, `contentHash`; neighbours are ≤3 chunks
  before and ≤3 after, or the first chunk plus ≤5 ahead when opened without an
  anchor) or `{ status: "unavailable", reason, document, source }` with S13's
  exact missing-source reasons: `document-deleted` (owned tombstone),
  `chunk-deleted`, `document-not-ready`, `content-version-mismatch`.
  Ordering is deliberate: authentication → project ownership → document
  ownership (a foreign or unknown id is the same non-enumerating `NOT_FOUND`
  as S05/S08, so ownership probing cannot enumerate anyone's documents) →
  tombstone → chunk resolution (a foreign chunk id answers identically to a
  missing one, with no locator or text) → cited-hash freshness → readiness.
  No `storage.getUrl`, no storage/file ids and no bytes ever leave the query:
  the viewer reads the caller's own `documentChunks` rows, and original bytes
  stay behind the authenticated `/private-files/:fileId` action.

### Deletion and stale citations

Deleting a document removes its job, embedding vectors, chunk rows, private
file row and stored blob within the bounded loop, then leaves only the
tombstone. Retrieval never offers the deleted source again (its vectors are
gone), and opening an old citation link returns the explicit unavailable
panel — never a broken link, crash or silent empty panel. While cleanup is in
flight the tombstone's `pending` status makes any surviving vector classify as
`document-not-ready` under S13, so a half-deleted document can never surface
as a citation.

### App surface and limits

Hash routes `#/projects/:id/documents` and
`#/projects/:id/sources/:documentId[/:chunkId][?hash=…]`. The list re-polls
every 1.5 s **only while a job is live**, then stops; upload reuses one
client-generated idempotency key per selected file; deletion drives the
bounded loop with the same 100×50 caps as project deletion and surfaces an
exhausted cap as `DELETION_INCOMPLETE`. Deliberate limits: extracted source
text with page/heading anchors rather than rendered PDF pages; no in-app file
download (that would need a tokenised request and is out of scope); the
`#/preview/*` fixtures are `import.meta.env.DEV`-only and stripped from
production builds. Evidence: `packages/api/tests/document-management.test.ts`
(12), `packages/api/tests/citation-source.test.ts` (7),
`packages/app/tests/e2e-documents.test.tsx` (3, upload-to-ready, citation
access-denied, deletion cleanup) plus component tests, and screenshots in
`docs/evidence/s22/`.

## S20 concept-learning mode, selection and progress events

Schema/function version 11 — `v11 = v10 (S19 union S22) union S20` — unions S20's additive scope with the version-10 release (S22's tombstone/index plus S19's language-practice settings), which itself followed S14's version 8: `progressEvents` gains optional S20 columns (`idempotencyKey`, `activity`, `objective`, `difficulty`, `outcome`, `evidence`, `turnId`, `references`, `targetEventId`, `feedbackValue`, `retractedAt`) plus two indexes (`by_owner_project_idempotency`, `by_owner_project_target`), and `projects` gains optional `objective`/`difficulty`. Every new column is optional, so an S04-era event row and a v9 project row still validate and read as unset; no backfill exists. `bootstrapSchemaV11` (the same replace-the-marker step every version bump takes, renamed forward by S24 to `bootstrapSchemaV12`) adopts any older deployment in place and keeps the idempotent `nextAttemptAt` backfill so a pre-v6 deployment is not skipped — run `npx convex run internal.migrations.bootstrapSchemaV12 '{}'` after deploying this release so `checkCompatibility` passes. Rollback is a code rollback while no S20 selection or S20 event rows exist; a populated v11 deployment (a project with `objective`/`difficulty`, or a typed `progressEvents` row) must stay on a compatible v11+ release until a separately tested downgrade exists. As with S15/S18, `convex/_generated/api.d.ts` gained the `concept` module entry by hand because offline `npx convex codegen` needs a configured deployment. `progressEvents` already join the S04 two-phase deletion protocol, so no deletion change was needed.

### Selection: objective and difficulty

`selectObjectiveAndDifficulty({ projectId, objective, difficulty })` stores the learner's concept-learning selection on the project row: the objective is trimmed free text capped at 500 characters (`INVALID_ARGUMENT` when empty, `OBJECTIVE_TOO_LONG` above the cap), `difficulty` is the typed set `beginner | intermediate | advanced`, and there is no clear path yet (documented limit, mirroring the S21 `mode` selection). `getSelection` is the owner-only read; identity always comes from `ctx.auth` through S05/S06 `requireUserId`, and a foreign, deleted or anonymous request is a non-enumerating `NOT_FOUND`/`UNAUTHENTICATED`. The selection surface lives entirely in `convex/concept.ts`, so S19's nearby mode/language code is untouched.

### Activities: `runActivity`

`runActivity({ projectId, turnId, activity, text, sessionKey?, rerank? })` (action, `packages/api/convex/concept.ts`) runs the explain / socratic / teach-back / short-quiz activities through the S14 turn pipeline **reused, not rewritten**: authentication → argument validation → `authorizeConceptScope` (project ownership plus the stored selection; `CONCEPT_SELECTION_REQUIRED` names the missing fields before any turn row, retrieval or provider call) → `ensureSession`/`beginTurn` → S11 `tutorClient` (`TURN_NOT_CONFIGURED` when no key) → embedding + S13 `retrieveProjectContext` → `recordRetrieval` → prompt build → `runTutorTurn` with the existing bounded retries and cancellation watcher → `commitTurn` (the S14 citation validation and single-transaction write) → `recordActivityEvent`. The S11 single-user policy gate still applies (`TURN_POLICY_BLOCKED`), the only endpoints touched are NaN `/embeddings` and `/chat/completions`, and the orchestrator change in `tutor.ts` is limited to exporting the primitives the action composes (`tutorClient`, `requireTurnId`, `requireLearnerText`, `resolveSessionKey`, `safeFailTurn`, the three validators).

The system instruction is `buildConceptSystemPrompt` (`packages/worker/src/concept/prompt.ts`): a pure function of goal, objective, difficulty, activity and evidence mode, so document text can never reach it — the S14 JSON user envelope carries learner text, history and passages as data, byte-identical for hostile and benign documents with the same settings. **Question-first is enforced, not assumed:** a `socratic` reply, and an ungraded `teach-back`/`quiz` reply (no `Verdict:` line), must contain a real question — a word run terminated by `?`/`？` (`hasQuestion`), so a bare question mark, `??` or a lecture with an isolated mark appended never satisfies the guard; otherwise the turn fails before any write with `ACTIVITY_NOT_QUESTION_FIRST` and stores zero messages and zero events. A checked reply carries its verdict instead, so a finished quiz can close without a question. A failed turn row is terminal like S14's: the learner retries with a fresh `turnId`.

### Grading, evidence honesty and outcomes

Teach-back and quiz feedback must end with exactly one line of the form `Verdict: <correct|partially-correct|wrong|uncertain>`; `extractActivityVerdict` reads the **last** canonical line and a missing or malformed line parses to nothing, so `resolveActivityOutcome` records `uncertain` instead of an invented grade (`explain`/`socratic` turns record `completed`). Graded feedback links to source evidence through the S14 citation path: markers outside the retrieved set are dropped (`unresolvedMarkers`) and a citation can only ever be an owned, retrieved, `ready` chunk. Without evidence the stored feedback carries the server-composed `NO_EVIDENCE_STATEMENT` prefix, the event stores `evidence: "insufficient-evidence"` with an empty `references` array, and the prompt forbids presenting general knowledge, a wrong answer or a guess as a document fact. No learning outcome is guaranteed and no authoritative advice is invented anywhere in the prompt contract.

### Progress events and reversible feedback

`recordActivityEvent` (internal, S04-style explicit-`ownerId` server-caller contract) writes exactly one `activity-completed` event per turn, keyed by `idempotencyKey = "<turnId>:activity-completed"`: a replayed `runActivity` call returns the same `progressEventId` instead of a duplicate, every reference is re-checked against the live owned chunk and ready document before it is stored, and the event snapshots the objective/difficulty selection, the activity, the explicit outcome and the evidence status. `listProgressEvents({ projectId, limit? })` is the owner-only page (default 50, max 200, newest first) that re-validates references on read and reports anything that no longer resolves in `droppedReferences`, leaving the stored row untouched.

Feedback is one active event per `activity-completed` target: `recordFeedback({ projectId, targetEventId, value: "helpful" | "not-helpful" })` reports `already-recorded` for a repeat (the active row is found deterministically, newest-first over a documented window of the 50 newest feedback rows for the target — a repeat is refused while an active row exists, so that row is always the newest one), and only S20 activity events are valid targets (an S04 `recordProgress` row or a feedback row is `NOT_FOUND`). `retractFeedback({ projectId, feedbackEventId })` is the reversible undo: it stamps `retractedAt` on the feedback row **and** inserts a `feedback-retracted` event pointing back at it, so the reversal is recorded durably; a second retraction reports `already-retracted` and never writes a second reversal, and the learner can rate the activity again afterwards.

### Offline test evidence

`packages/worker/tests/concept.test.ts` (6 tests) covers prompt purity (byte-identical hostile/benign, only goal/objective/difficulty/activity/evidence mode interpolated), the per-activity asking/checking rules, the question-first guard matrix, the verdict fixtures in `tests/fixtures/concept-answers.json` (correct, partially-correct, wrong, uncertain, case/spacing, malformed and missing verdicts, last-line-wins, a no-evidence-prefixed reply) and the JSON envelope round-trip. `packages/api/tests/concept.test.ts` (9 tests) drives the whole action with a mocked NaN `fetch`: selection validation/isolation and `CONCEPT_SELECTION_REQUIRED` before any provider work; a grounded explain turn with its idempotent progress event and replay; question-first socratic behaviour plus the `ACTIVITY_NOT_QUESTION_FIRST` rejection of a lecture-only reply for `socratic`, `teach-back` and `quiz` with zero stored rows; teach-back/quiz grading fixtures for all four outcomes with evidence-linked feedback and references; evidence-linked quiz feedback beside the no-evidence path (`NO_EVIDENCE_STATEMENT`, fabricated marker dropped, empty references); document prompt injection (identical system prompts, envelope-only document text, foreign project denial, own-chunks-only rows); give/repeat/retract/re-retract feedback with the recorded reversal and foreign/anonymous denials; the S11 not-configured and policy-blocked failures; and cancellation leaving zero messages, citations and events. `packages/api/tests/schema-lifecycle.test.ts` covers the v11 marker (clean reset, retry, v2/v4/v5/v7/v8 upgrades, v4 backfill, newer-schema rejection at 12). Synthetic fixtures and mocked provider responses only: no live NaN/LLM call exists anywhere in `pnpm test`.

### Operational limits

One activity event per `turnId` (idempotency key), at most 50 references per event (the S14 citation maximum), progress pages of at most 200 events, one active feedback event per activity target (retract to re-rate), objective ≤ 500 characters, learner text ≤ 4,000 characters, answer ≤ 16,000 characters, and the S14/S13 bounds unchanged (top-k 8, 6,000-character context, 50 citations, bounded retries and poll interval). A lecture-only reply for an asking activity fails the turn visibly rather than being stored; queue-depth and quota handling remain S24's scope.
## S24 bounded observability, rate limits and privacy lifecycle

### Schema/function version 12 and migration

Schema/function version 12 — `v12 = v11 union S24` — is purely additive: three
empty tables (`rateLimitBuckets`, `telemetryEvents`, `deletionRequests`), the
`tutorTurns.by_owner_status` index for the concurrent-turn cap, the
`projects.by_owner_deleted` index for the account sweep, and one auth-table
override (`authVerifiers` re-declared with an extra `sessionId` index —
`authTables` indexes only `signature`, so without it a session-bound PKCE
verifier could never be removed with its session). Nothing backfills:
`bootstrapSchemaV12` (renamed forward from V11, same replace-the-marker step)
keeps the idempotent `nextAttemptAt` backfill so a pre-v6 deployment is not
skipped — run `npx convex run internal.migrations.bootstrapSchemaV12 '{}'`
after deploying this release so `checkCompatibility` reports
`foundSchemaVersion: 12`. Rollback is a code rollback while the S24 tables are
empty and no release queries the new indexes; a populated v12 deployment
(telemetry rows, active ledger rows, rate buckets) must stay on a compatible
v12+ release until a separately tested downgrade exists, and removing a table
again requires pushing a schema without it once no release reads it.
`convex/_generated/api.d.ts` gained the `audioLimits` and `observability`
module entries by hand for the usual reason (offline `npx convex codegen`
needs a configured deployment).

### Tenant-aware throttling and Retry-After

`observedRoute` (`packages/api/convex/observability.ts`) wraps the five costly
POST actions in `http.ts` — `/private-uploads`, `/stt/transcribe`,
`/translation/audio`, `/translation/text`, `/tts/synthesize` — in a fixed
order: identity from `ctx.auth` → per-learner fixed-window bucket → the
unchanged handler → one redacted telemetry row (only when the request resolved
to a project the caller owns). Anonymous requests fall straight through to the
handler's `401`, and the wrapper never invents or suppresses a denial: it adds
protection, never authorization (a foreign project still answers the handler's
non-enumerating `404` even with a fresh bucket).

Configuration (documented in `.env.example`, read per request, clamped):
`RATE_LIMIT_REQUESTS` (default 60, 1..10000) per `RATE_LIMIT_WINDOW_SECONDS`
(default 60, 1..3600), one bucket per learner and route
(`by_owner_bucket`). The request that crosses the limit is refused with
`429 { code: "RATE_LIMITED", retryAfterMs }` plus the standard
`Retry-After: <ceil seconds>` header, `x-trace-id`, and the route's CORS
headers, and consumes no provider work; denied attempts never extend the
window count. `applyRateLimit` is a pure function of `(state, limit,
windowMs, now)`, so both the header and the exact next-attempt moment are
arithmetic the tests assert without sleeping. The limiter mutation fails open:
a storage blip must never take a route down, and it cannot bypass a permission
check because ownership stays inside the handler.

Bounded retries honour the same budget in both directions:

- **Server:** the S14 tutor retry loop already uses
  `failure.retryAfterMs` as its delay floor (`packages/worker/src/tutor/turn.ts`)
  and every provider `429` on the STT/translation/TTS routes now also emits the
  `Retry-After` header alongside `retryAfterMs`.
- **Client:** `requestTranscription` (`packages/app/src/transcribeClient.ts`)
  performs at most one bounded auto-retry (`DEFAULT_TRANSCRIBE_MAX_ATTEMPTS`
  = 2 attempts total). The wait is the larger of the `Retry-After` header
  (delta-seconds) and the body's `retryAfterMs`; a declared wait beyond
  `MAX_AUTO_RETRY_MS` (15 s) is **never truncated** — the failure surfaces with
  the full wait instead of retrying early — and an abort stops both the wait
  and the next attempt (`packages/app/src/retryPolicy.ts`). The translation and
  TTS clients surface the wait as fixed copy ("Try again in N seconds") without
  auto-retry.

The **per-user concurrent-turn cap** lives at the `beginTurn` linearization
point: a brand-new turn (or an expired-lease takeover) is refused with
`{ state: "rate-limited" }` when the owner already holds
`MAX_CONCURRENT_TURNS` (default 3, clamped 1..10) live `running` rows across
every project — `runTurn` and `runActivity` map it to the typed
`TURN_CONCURRENCY_LIMIT` before any provider request, and the browser maps that
code to fixed copy. Only rows whose lease has not expired count (a stale row
can never lock its owner out of the cap), and the same-`turnId`
`in-progress` idempotency answer is unchanged.

The **audio-duration cap** is server-side (`packages/api/convex/audioLimits.ts`):
the container's own header is parsed before any provider request — MP4 `mvhd`
and Matroska/WebM `Segment > Info > Duration × TimecodeScale` — and a declared
duration above `MAX_AUDIO_DURATION_SECONDS` (default 60, clamped 5..600)
answers `413 { code: "AUDIO_TOO_LONG", maxDurationSeconds }` with zero
provider calls. Every malformed, truncated or absent duration resolves to
"unknown", never a guess: OGG and live WebM streams without a Segment Duration
stay bounded by the 8 MiB byte cap and the browser's 60-second recording
budget (a documented residual, recorded in `docs/provider-data-handling.md`).
The **upload-size cap** is unchanged from S08: `MAX_UPLOAD_BYTES` (empty →
10 MiB product cap, never above `10485760`), with the existing boundary and
clamping tests in `upload-contract.test.ts`/`document-uploads.test.ts`.

### Redacted telemetry and log retention

Telemetry is redacted by construction, not by filtering afterwards. The
`telemetryEvents` validator fixes the column set (ids, timings and a handful
of bounded numbers), and `buildTelemetryRow` copies only allowlisted inputs:
`event` and `status` must be members of fixed sets, `traceId`/`ownerId` must
match identifier patterns (no whitespace), numeric fields are range-checked,
and `code` must be in the explicit `TELEMETRY_CODES` allowlist — so an
uppercase, key-shaped secret can never qualify by *looking* like a token. An
unrecognized value drops that field (or, for an unknown event/status/shape,
the whole row) instead of throwing, which is what lets turn telemetry live in
the same transaction as `commitTurn`/`failTurn` without ever risking a
rollback. Nothing a caller could attach is copied: the S20 canary tests pass
prompt, transcript and key strings through the builder and through real turn
and route writes, then assert none of them appears in the serialized rows.

Rows are written from exactly two places: the route wrapper (a fresh
`traceId` per request, echoed as `x-trace-id` on every wrapped response) and
the turn path (`commitTurn` → `ok`, `failTurn` → `error` with the typed code,
`cancelTurn` → `cancelled`; the `traceId` is the turn id, so a row carries only
ids, attempts and `durationMs`). `recordRouteEvent` re-verifies
`(ownerId, projectId)` ownership before a row may exist, so every row names a
project its owner actually owns and a project deletion removes its telemetry
with everything else. The only `console` call site in this package logs a
fixed message plus a token-shaped code, never an error message or stack.

Retention is configured and rotated: `LOG_RETENTION_DAYS` (default 30,
clamped 1..365) sets the cutoff and the hourly `telemetry-retention` cron runs
`cleanupTelemetry`, which deletes at most 100 expired rows per call so an
oversized backlog drains across scheduled runs instead of one unbounded
mutation. `rateLimitBuckets` carry no content either (owner, route bucket,
window, count) and live until account deletion.

### Privacy lifecycle: project and account deletion

Project deletion keeps the S04 two-phase protocol and gains a visible ledger.
`requestProjectDeletion` soft-deletes the root and opens (or re-arms) a
`deletionRequests` row as `pending`; every `deleteProjectBatch` marks it
`deleting` with an attempt count, and only after the completion probe finds
zero remaining rows does the batch delete the ledger row and then the project
(a finished deletion therefore never leaves a reference to a project that no
longer exists). The cascade now covers **every** table the story names:
documents with their storage blobs and `privateFiles` rows, `ingestionJobs`
(provider-job remnants), `documentChunks`, `chunkEmbeddings`, `messages`,
`citations`, `tutorTurns`, `practisedTopics`, `progressEvents`,
`learningSessions`, `learningGoals`, plus the S24 `telemetryEvents` and the
S06 `agentConnectionTokens`. Failure is visible and retriable: a client
observing a rejected or interrupted batch calls
`reportDeletionFailure({ scope, projectId?, code })` (owner-only, fixed
uppercase `code`, sanitized to `DELETION_FAILED` otherwise — a message can
never be stored), `getDeletionStatus` exposes `pending`/`deleting`/`failed`
per owned project and for the account, and the retry re-enters the same
idempotent flow from the records that are still there. A completed deletion
cannot be downgraded (reporting afterwards is `NOT_FOUND`), and completed
ledger rows are removed, so an empty status means nothing is in flight.

Account deletion is a staged, bounded sweep driven by
`requestAccountDeletion` (opens the account ledger, soft-deletes up to 100
live projects) and `runAccountDeletionBatch(limit ≤ 100)`:

1. soft-delete live projects (`by_owner_deleted`) — and stop, if more live
   projects remain, so content of a project that has not entered deletion is
   never touched;
2. documents with their blobs and registry rows, then every owner-scoped child
   table (the same list as above, by `ownerId` prefix);
3. project rows, together with their project-scoped ledger rows;
4. only when nothing else remains: owner-level `rateLimitBuckets`, the
   sign-in `authRateLimits` rows for the user's identifiers, then the Convex
   Auth identity in strict child-before-parent order — verification codes,
   accounts, refresh tokens, verifiers, sessions, and the `users` row itself
   only when every child is already gone;
5. a completion probe closes the account ledger row.

A repeat call after completion reports `{ completed: true, deleted: 0 }`
(idempotent close); a missing ledger with remaining residue is `NOT_FOUND`,
so the driver must request first. Known residual: the pinned S06 access token
lives up to 1 hour, so a retained token can act on the deleted id until it
expires (the rows it creates reference an owner with no remaining login); the
client signs out on completion. Both flows are non-enumerating
(`UNAUTHENTICATED`/`NOT_FOUND`) and never weaken S05/S06 authorization.

### App surface

No new UI states were added: the existing failure surfaces carry the new
codes. `generatingFailureMessage` maps `TURN_CONCURRENCY_LIMIT` to fixed copy,
`mapDocumentError` maps `RATE_LIMITED`, every message is server-code-keyed
with no backend interpolation, and the transcription client's bounded
Retry-After retry is invisible until a `429` occurs.

### Offline test evidence

`packages/api/tests/rate-limits.test.ts` (10): window arithmetic with the
exact denial budget and boundary, configuration clamps, the internal consumer
under an explicit clock (counts, isolation per learner/route, scope
resolution), the observable `429` + `Retry-After` + CORS + `x-trace-id`
contract with zero provider calls, the provider-`429` header, and anonymous /
foreign-project negatives.
`packages/api/tests/telemetry.test.ts` (8): builder allowlist and canary
dropping (prompt, key and a key-shaped `AKIA…` secret), stored-row key sets
and `x-trace-id` ↔ `traceId` matching, turn rows for success and typed failure
with the learner text canary absent from telemetry but present in the
transcript, rate-limited rows, and retention (`LOG_RETENTION_DAYS` clamp,
bounded 100-row batches draining a 150-row backlog).
`packages/api/tests/audio-limits.test.ts` (8): hand-built MP4/WebM fixtures,
malformed/truncated/duration-less input resolving to unknown, configuration
clamps, `413 AUDIO_TOO_LONG` before any provider call on both audio routes,
the configured cap applied at request time, and unknown-duration input passing
under the byte cap.
`packages/api/tests/turn-concurrency.test.ts` (5): the cap rejecting a third
live turn with zero provider calls, `in-progress` unchanged at the cap,
expired leases freeing slots, a completed turn under the cap with its
telemetry row, and configuration clamps.
`packages/api/tests/deletion-lifecycle.test.ts` (5): the project cascade over
every table plus blobs and the ledger with a second learner untouched, the
visible `failed` state with owner-only reporting and resumption to completion,
failure-code sanitization, the account sweep draining content, buckets,
telemetry and all auth tables (including `authRateLimits` for the user's
email) while sparing another learner, and an idempotent retriable account
failure. `packages/app/tests/retry-after.test.ts` (12): `Retry-After` parsing,
delay arithmetic, the never-truncate decision, the exact next-attempt timing
under an injected clock, bounded exhaustion, abort-during-wait, no retry for
non-429 failures, and the new fixed copy. `schema-lifecycle.test.ts` covers
the v12 marker (clean reset, retry, v2..v8 adoption, newer-schema rejection at
13). Synthetic fixtures and mocked providers only: no live NaN/Convex/provider
call exists anywhere in `pnpm test`.

### Operational limits

Per learner: 60 requests/60 s per costly route (configurable), 3 live turns
(configurable 1..10), 60 s audio from the container header (configurable
5..600 s) and 8 MiB per request, 10 MiB per upload, bounded transcription
retries (2 attempts, never before the declared wait, never waiting more than
15 s automatically). Telemetry: ids/timings only, 30-day default retention,
100 rows per cleanup batch, one hourly cleanup. Deletion: batches of ≤100 row
deletions, the app driver caps at 500 batches per project and surfaces
`DELETION_INCOMPLETE` beyond that; account sweeps are bounded the same way.
Identity teardown happens last and only after all content is gone.

## Plan and operational limits

The selected plan is **Convex Free**, never metered Starter. Checked limits: 0.5 GB database, 1 GB/month database I/O, 1 GB file storage, 1 GB/month data egress, 0.5 GB search storage, 3,000 query-GB/month search and 1 million function calls/month. Reconfirm actual plan and current limits at any authorized provisioning/deployment; quota exhaustion must fail visibly and must not trigger paid upgrade. Roll back a failed release by redeploying the previous compatible commit; do not downgrade a populated schema until data compatibility is assessed.
