# v0.1 development backlog

4 epics and 26 stories. Stable planning IDs map E01-E04 to GitHub #1-#4 and S01-S26 to #5-#30. Use EXECUTION_ORDER.md and order labels, not numerical issue order. A blocked story starts only after its prerequisites are closed and verified.

## E01: [Epic] Foundation, authentication and tenant isolation

Labels: epic

## Outcome
Foundation, authentication and tenant isolation.

## Child stories
- [ ] S01
- [ ] S02
- [ ] S03
- [ ] S04
- [ ] S05
- [ ] S06
- [ ] S07

## Acceptance
- All child stories meet their acceptance criteria and linked tests.
- Release acceptance S26 passes before v0.1 closes.

## Factory note
Epic is tracking only, not an implementation task. Replace planning IDs with GitHub issue references when publishing.

## E02: [Epic] Private documents and grounded retrieval

Labels: epic

## Outcome
Private documents and grounded retrieval.

## Child stories
- [ ] S08
- [ ] S09
- [ ] S10
- [ ] S11
- [ ] S12
- [ ] S13

## Acceptance
- All child stories meet their acceptance criteria and linked tests.
- Release acceptance S26 passes before v0.1 closes.

## Factory note
Epic is tracking only, not an implementation task. Replace planning IDs with GitHub issue references when publishing.

## E03: [Epic] Spoken tutor and learning modes

Labels: epic

## Outcome
Spoken tutor and learning modes.

## Child stories
- [ ] S14
- [ ] S15
- [ ] S16
- [ ] S17
- [ ] S18
- [ ] S19
- [ ] S20

## Acceptance
- All child stories meet their acceptance criteria and linked tests.
- Release acceptance S26 passes before v0.1 closes.

## Factory note
Epic is tracking only, not an implementation task. Replace planning IDs with GitHub issue references when publishing.

## E04: [Epic] Web experience and release quality

Labels: epic

## Outcome
Web experience and release quality.

## Child stories
- [ ] S21
- [ ] S22
- [ ] S23
- [ ] S24
- [ ] S25
- [ ] S26

## Acceptance
- All child stories meet their acceptance criteria and linked tests.
- Release acceptance S26 passes before v0.1 closes.

## Factory note
Epic is tracking only, not an implementation task. Replace planning IDs with GitHub issue references when publishing.

## S01: Record architecture and runtime decisions

Labels: infra, story

## Goal
Choose frontend framework, API/worker runtimes, package layout and deployment boundary in an ADR.

## Scope exclusions
Do not provision paid infrastructure or create the development factory.

## Prerequisites
None

## Acceptance criteria
- [ ] ADR compares runtime upload/time limits and deployment options.
- [ ] Documents single-user NaN deployment and the hosted multiuser gate. Cloudflare hosts agents only on the Free plan; frontend hosting is separate, and Convex Auth is the sole application identity layer.
- [ ] Records web/API/worker interfaces and versioned configuration.

## Required test evidence
ADR review against official provider and runtime docs.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S02: Scaffold TypeScript workspace and developer commands

Labels: infra, story, blocked, good-first-issue

## Goal
Create app, API, worker and shared contract packages with pinned dependencies.

## Scope exclusions
No business features.

## Prerequisites
S01

## Acceptance criteria
- [ ] Clean checkout installs with a lockfile and supported Node version.
- [ ] One command each runs lint, typecheck, tests and build.
- [ ] Example config contains empty/synthetic values; ignore local env and upload/audio directories.

## Required test evidence
Clean-checkout CI using synthetic config.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S03: Set up reproducible Convex development backend and schema lifecycle

Labels: backend, story, blocked

## Goal
Configure pinned Convex SDK, local development/test workflow, schema.ts and generated typed functions.

## Scope exclusions
No Supabase, SQL, pgvector or paid backend provisioning.

## Prerequisites
S02

## Acceptance criteria
- [ ] Document supported dev setup, code generation and clean synthetic seed/reset workflow.
- [ ] Version schema/functions; changes needing data backfill have resumable migration functions and compatibility checks.
- [ ] Development and production deployments are separate; deployment credentials never enter client assets.
- [ ] Choose Convex Free, not metered Starter; record actual plan and limits before any authorized cloud provisioning.

## Required test evidence
Fresh-checkout generated types, synthetic reset twice, schema compatibility and migration retry tests.

## Delivery
One focused PR with tests and operational limits. Synthetic fixtures only. No secrets, paid provisioning or live account data.


## S04: Implement project and conversation data schema

Labels: backend, story, blocked

## Goal
Define Convex projects, goals, sessions, messages and progress_events with validators and indexes.

## Scope exclusions
No schema constraints assumed; no sharing or billing.

## Prerequisites
S03

## Acceptance criteria
- [ ] All private records include owner and project scope; mutation checks enforce referenced project ownership.
- [ ] Indexes support owner/project access without full-table scans.
- [ ] Stable turn IDs, server timestamps and duplicate detection prevent retry duplicates.
- [ ] Schema evolution and deletion semantics documented.

## Required test evidence
Validator and function tests for malformed and cross-owner references.

## Delivery
One focused PR with tests and operational limits. Synthetic fixtures only. No secrets, paid provisioning or live account data.


## S05: Enforce Convex function authorization and private file access

Labels: security, story, blocked

## Goal
Enforce authorization in every public Convex query, mutation, action and private-file HTTP action.

## Scope exclusions
No database RLS assumptions; no admin credential in browser; no private getUrl links.

## Prerequisites
S04

## Acceptance criteria
- [ ] Use ctx.auth.getUserIdentity plus verified ownership, never client-supplied owner IDs as authority.
- [ ] Anonymous requests denied and user A cannot read/mutate user B records, files, search or agent state.
- [ ] Internal functions are not public; server credential paths still enforce owner/project checks.
- [ ] Private file bytes served through authenticated authorized HTTP actions; storage.getUrl is bearer access and is not an expiring private link.
- [ ] Cache keys and indexes preserve tenant boundaries.

## Required test evidence
Two-user negative tests across queries, mutations, actions, file endpoints, vector search and caches.

## Delivery
One focused PR with tests and operational limits. Synthetic fixtures only. No secrets, paid provisioning or live account data.


## S06: Implement Convex Auth sign-in and verified agent sessions

Labels: backend, story, blocked

## Goal
Implement Convex-compatible auth without requiring a paid external auth SaaS.

## Scope exclusions
No Cloudflare Access; no credential recovery or OAuth registration without separate authority.

## Prerequisites
S05

## Acceptance criteria
- [ ] Record auth choice in ADR: Convex Auth is beta and supports OAuth/password/email methods; pin version and test chosen frontend support.
- [ ] Prefer OAuth GitHub/Google for initial implementation after configuration review; no external paid auth SaaS is required.
- [ ] Email OTP/recovery needs a configured email provider; passwords without recovery are not a production default.
- [ ] Queries/mutations/actions derive verified identity from ctx.auth; expiry/sign-out/refresh handled correctly.
- [ ] Cloudflare agent handshake has verified scoped identity, expiry and reconnect checks; no email-only or user-ID-only binding.

## Required test evidence
Auth tests for missing/forged/expired tokens, sign-out, refresh, callback allowlist and agent reconnect.

## Delivery
One focused PR with tests and operational limits. Synthetic fixtures only. No secrets, paid provisioning or live account data.


## S07: Host project-scoped agents on Cloudflare Free plan

Labels: infra, story, blocked

## Goal
Host learner agents with Cloudflare Agents SDK on Workers and SQLite-backed Durable Objects using the Workers Free plan.

## Scope exclusions
No Cloudflare Access authentication gate, no general frontend hosting, no Workers AI inference, no paid-plan activation.

## Prerequisites
S01, S06

## Acceptance criteria
- [ ] Pin SDK/runtime versions and document official Free-plan compute/storage limits.
- [ ] Validate Convex-compatible authenticated identity and project ownership before agent connections, state reads, calls and reconnects.
- [ ] Agent instance IDs cannot expose another user's project or conversation.
- [ ] Durable Object state contains only necessary scoped state; Convex remains the durable project/document store.
- [ ] Use SQLite-backed Durable Objects compatible with Free plan; quota exhaustion fails safely with a visible message.
- [ ] LLM, speech, embeddings and rerank call NaN through server-side adapters, not Workers AI.
- [ ] No automatic paid upgrade or new spending.

## Required test evidence
Agent connection/reconnect and two-user isolation tests; local SDK smoke test; quota exhaustion simulation and Free-plan configuration review.

## Delivery
One focused PR, synthetic fixtures only. Record tests and operational limits. No live secrets or paid provisioning.

## Cross-runtime boundary
Cloudflare stores agent runtime state only. Convex owns projects, files and messages. Choose a supported JWT/OIDC or short-lived scoped server-issued connection token after verifying the selected auth provider; do not assume Convex Auth tokens are automatically accepted by Cloudflare. Cloudflare may call Convex through authenticated user-scoped functions; shared server secrets are not a substitute for owner checks.


## S08: Implement safe document uploads and metadata

Labels: backend, story, blocked

## Goal
Upload private PDF, Markdown and plain text to Convex file storage with authenticated project metadata.

## Scope exclusions
No arbitrary URL ingestion or OCR; no public bearer download URLs.

## Prerequisites
S05, S06

## Acceptance criteria
- [ ] Use authenticated HTTP upload action for initial private files with configurable maximum <=10 MiB, below Convex HTTP 20 MB limit.
- [ ] Validate MIME/extension/content, size and filename before saving; delete rejected/orphan files.
- [ ] Store _storage ID only after project ownership and content checks; queue one idempotent job.
- [ ] Downloads/citations require auth on every request and do not expose storage.getUrl.
- [ ] Show pending/failed/ready and quota errors without content leakage.

## Required test evidence
Synthetic file fixtures, size/error/orphan cleanup and two-user upload/download tests.

## Delivery
One focused PR with tests and operational limits. Synthetic fixtures only. No secrets, paid provisioning or live account data.


## S09: Build resumable ingestion job runner

Labels: backend, story, blocked

## Goal
Implement job leases, retries, parser execution and ingestion status.

## Scope exclusions
No inline long-running request dependency.

## Prerequisites
S08

## Acceptance criteria
- [ ] Parser runs with time/memory safeguards and no arbitrary document execution.
- [ ] Jobs retry safely with bounded backoff and dead-letter failure state.
- [ ] Idempotent content/version keys prevent duplicate chunks after retries.
- [ ] Interrupted jobs resume or expire deterministically; encrypted/scanned PDFs show explicit unsupported state.

## Required test evidence
Worker crash/retry tests and synthetic PDF/text extraction fixtures.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S10: Implement source-aware document chunking

Labels: ai, story, blocked

## Goal
Create chunks with stable source IDs, pages/headings, ordering and content hashes.

## Scope exclusions
No embedding index choice here.

## Prerequisites
S09

## Acceptance criteria
- [ ] Chunk size/overlap are configurable and measured.
- [ ] Empty chunks and duplicate versions are handled deterministically.
- [ ] PDF page and text heading references survive chunking.
- [ ] Document text remains data, never tutor instruction.

## Required test evidence
Deterministic fixtures for long text, headings, PDF pages and adversarial instructions.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S11: Add NaN adapters and document provider policy gate

Labels: ai, story, blocked

## Goal
Use NaN for every documented AI stage: typed adapters for models, LLM tutor/text translation, LLM streaming, qwen3-embedding, rerank, Whisper STT/audio-to-English translation and Kokoro TTS.

## Scope exclusions
No pooling the deployer personal key across learners; no real provider calls in ordinary CI.

## Prerequisites
S02

## Acceptance criteria
- [ ] Base URL is https://api.nan.builders/v1; keys are server-side and redacted.
- [ ] Contract tests cover timeouts, 429, unsupported models, malformed payloads and cancellation. Verify every AI capability routes through NaN; model/voice/language choices and quota controls are explicit.
- [ ] Separate nonstandard rerank endpoint from standard OpenAI client methods. No silent provider fallback; document and surface unsupported capabilities.
- [ ] Document personal non-transferable key terms and restrict initial live deployment to single user.
- [ ] Hosted multiuser credential custody/provider agreement is explicitly unresolved, not automatically solved by BYOK.

## Required test evidence
Mock contract tests plus opt-in smoke test instructions; record current official API/model/terms docs.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S12: Validate NaN 4096-dimension embeddings with Convex vector search

Labels: ai, story, blocked

## Goal
Test qwen3-embedding vectors against the pinned Convex SDK/deployment and implement compatible project-filtered vector index.

## Scope exclusions
No pgvector/HNSW SQL; no silent vector truncation or provider substitution.

## Prerequisites
S03, S10, S11

## Acceptance criteria
- [ ] Current vector-search guide and platform limits allow dimensions 2-4096, but VectorIndexConfig API reference says 2-2048. Resolve with actual index creation/query spike; record SDK version and result.
- [ ] Store vectors as v.array(v.float64()), with model/version/dimension metadata; reject mismatches.
- [ ] If 4096 works, use full qwen3-embedding vectors and owner/project filterFields; if not, block and document provider-supported alternatives for decision.
- [ ] Vector search runs in an action with authorization and filters before retrieval; recheck result ownership before returning context.
- [ ] Record search quota: each search charges full index size in query-GB regardless of filters; benchmark corpus, relevance and p95 latency.

## Required test evidence
Synthetic 4096-dimensional create/index/query test, dimension rejection, two-user isolation and quota estimate; no paid live deployment without approval.

## Delivery
One focused PR with tests and operational limits. Synthetic fixtures only. No secrets, paid provisioning or live account data.


## S13: Build scoped retrieval, reranking and citation contract

Labels: ai, story, blocked

## Goal
Retrieve only ready chunks in one owned project, rerank candidates and return bounded citation context.

## Scope exclusions
No corpus-wide search across tenants or unbounded prompt context.

## Prerequisites
S05, S10, S11, S12

## Acceptance criteria
- [ ] Owner/project filters are applied in the Convex vector-search filter, not only after.
- [ ] Returns stable document/chunk/page/heading IDs and supports deleted/missing sources.
- [ ] Empty corpus and low-confidence matches return explicit insufficient-evidence result.
- [ ] Context budget/top-k and optional rerank fallback are deterministic.

## Required test evidence
Two-user and two-project isolation tests plus gold-question relevance fixtures.

## Provider routing
Use NaN for this story's documented AI operations. Keep provider limits and unsupported features visible; do not silently substitute another provider.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S14: Implement grounded tutor orchestration

Labels: ai, story, blocked

## Goal
Build a session/turn orchestrator with RAG, streaming text and stored citation references.

## Scope exclusions
No external action tools or autonomous agents that modify user data.

## Prerequisites
S06, S11, S13

## Acceptance criteria
- [ ] Tutor uses project goal/mode and distinguishes document-backed answers from general explanations.
- [ ] Citations resolve to retrieved owned chunks; invented citation IDs are rejected.
- [ ] Document prompt injection cannot override system goals or access another project.
- [ ] Idempotent turn IDs and cancellation avoid duplicate messages.
- [ ] No-evidence answers say so and preserve useful learning guidance.

## Required test evidence
Mock LLM tests for injection, fake citations, no evidence, retries and cancellation.

## Provider routing
Use NaN for this story's documented AI operations. Keep provider limits and unsupported features visible; do not silently substitute another provider.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S15: Implement short-turn microphone capture and Whisper STT

Labels: frontend, story, blocked

## Goal
Record a microphone turn, send it via authenticated backend and display editable transcription.

## Scope exclusions
No claim of streaming STT; do not call audio translations for ordinary transcription.

## Prerequisites
S06, S11

## Acceptance criteria
- [ ] Handles permission denial, no microphone, silence and unsupported codecs.
- [ ] Recording limit is configured at <=60 seconds for v0.1 and request file size below provider 25 MB limit.
- [ ] Supported compressed format is tested and transcoded only in an approved backend runtime.
- [ ] Detect/select input language without forcing translation.
- [ ] Raw audio is discarded by default after processing; abort cancels pending work.

## Required test evidence
Browser tests plus fake transcription responses for timeout, 524 and 429.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S16: Add Kokoro speech synthesis and playback

Labels: frontend, story, blocked

## Goal
Generate tutor response audio through backend, select validated voices and play with text visible.

## Scope exclusions
No guarantee of all STT languages having a TTS voice.

## Prerequisites
S11, S14

## Acceptance criteria
- [ ] Voice/language availability is validated from provider config.
- [ ] Supports play/pause/stop and respects browser autoplay restrictions.
- [ ] Playback failure leaves complete transcript and retry action.
- [ ] Audio uses authenticated Convex HTTP delivery with access checked on every request; do not expose storage.getUrl bearer links and is not committed/logged.
- [ ] Cancelling a turn stops playback and rejects stale audio.

## Required test evidence
UI tests for blocked autoplay, unsupported voice, errors and private audio access.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S17: Assemble spoken conversation state machine

Labels: frontend, story, blocked

## Goal
Connect recording -> transcribing -> retrieving/generating -> speaking -> ready as the core experience.

## Scope exclusions
Continuous VAD/full duplex and realtime provider speech APIs are outside v0.1.

## Prerequisites
S14, S15, S16

## Acceptance criteria
- [ ] Each stage and error is visible, with retry/cancel and no duplicate turn.
- [ ] User can stop speech and start a new turn; old results never play over it.
- [ ] Transcripts/citations stay available while listening and after reconnect.
- [ ] Record p50/p95 stage and end-to-end latency on a documented sample; set release budget from measurements.

## Required test evidence
End-to-end two-turn voice test and race/cancellation/reconnect tests.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S18: Implement explicit translation behaviour

Labels: ai, story, blocked

## Goal
Expose audio-to-English translation and separately tested LLM text translation between selected pairs.

## Scope exclusions
No claim Whisper audio translations supports arbitrary target languages.

## Prerequisites
S11, S15

## Acceptance criteria
- [ ] UI distinguishes transcription, audio-to-English translation and LLM translation.
- [ ] Users choose target language; original text remains accessible.
- [ ] Unsupported combinations produce clear fallback rather than silent English.
- [ ] Model task obeys source text as data and preserves meaning in reviewed synthetic pairs.

## Required test evidence
Contract tests for Whisper English output and bilingual LLM evaluation fixtures.

## Provider routing
Use NaN for this story's documented AI operations. Keep provider limits and unsupported features visible; do not silently substitute another provider.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S19: Build language-practice tutor mode

Labels: ai, story, blocked

## Goal
Add target language, level, goals, roleplay and configurable correction style.

## Scope exclusions
Do not score phonemes/pronunciation accuracy from text transcripts.

## Prerequisites
S14, S18

## Acceptance criteria
- [ ] Tutor stays in chosen learning language unless user asks translation.
- [ ] Correction mode offers immediate or end-of-turn corrections with short examples.
- [ ] Difficulty adapts to selected level and user correction preference.
- [ ] History records practised topics without claiming certified proficiency.

## Required test evidence
Synthetic beginner/intermediate dialogues and correction-style evaluations.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S20: Build concept-learning tutor mode and progress events

Labels: ai, story, blocked

## Goal
Add explain, Socratic questioning, teach-back and short quiz activities grounded in project docs.

## Scope exclusions
No guaranteed learning outcomes or invented authoritative advice.

## Prerequisites
S04, S14

## Acceptance criteria
- [ ] User selects objective and difficulty; tutor asks/checks rather than only lectures.
- [ ] Quiz answers and feedback link to source evidence when available.
- [ ] Progress events capture activity/outcomes with reversible user feedback.
- [ ] Wrong/uncertain answers are handled without presenting speculation as document fact.

## Required test evidence
Synthetic concept corpus with teach-back and quiz answer fixtures.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S21: Build accessible project dashboard and onboarding

Labels: frontend, story, blocked

## Goal
Create responsive onboarding, project CRUD and goal/mode selection.

## Scope exclusions
No team or public sharing features.

## Prerequisites
S04, S06

## Acceptance criteria
- [ ] Signed-in user sees only owned projects and can create/edit/delete with confirmation for deletion.
- [ ] Empty/loading/error states are actionable.
- [ ] Keyboard navigation, labelled controls and mobile layout pass review.
- [ ] Provider configuration is server-side; UI never displays/stores a deployer secret.

## Required test evidence
Component tests, two-user E2E and screenshots at desktop/mobile sizes.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S22: Build document management and citation source viewer

Labels: frontend, story, blocked

## Goal
Show upload/progress/failure/retry/delete and citation previews scoped to the current project.

## Scope exclusions
No public file URLs or embedding inspector leaking other projects.

## Prerequisites
S08, S13, S21

## Acceptance criteria
- [ ] Status updates reflect real job state and safe retry.
- [ ] Citation opens correct document/page or heading with access checked.
- [ ] Missing/deleted sources have explicit unavailable state.
- [ ] Document deletion triggers source/chunk/job cleanup and stale citation handling.

## Required test evidence
E2E upload-to-ready and citation access-denied/deleted-source tests; visual screenshots.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S23: Add CI quality gates and factory contribution templates

Labels: infra, story, blocked, good-first-issue

## Goal
Create pull-request checks, issue/PR templates and synthetic fixture policy.

## Scope exclusions
No automatic deployment or paid provider smoke tests by default.

## Prerequisites
S02

## Acceptance criteria
- [ ] CI runs lint, typecheck, unit tests and build on clean checkout.
- [ ] Secret scanning and dependency checks flag leaks with documented remediation.
- [ ] PR template requires issue ID, scope, acceptance checklist and test evidence.
- [ ] Contribution guide requires explicit prerequisites and one focused change per PR.

## Required test evidence
Test green and deliberately failing sample branches without committing secrets.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S24: Add bounded observability, rate limits and privacy lifecycle

Labels: security, story, blocked

## Goal
Add tenant-aware throttling, redacted telemetry, audio policy and account/project deletion path.

## Scope exclusions
No logging full prompts, keys, raw audio or private documents.

## Prerequisites
S08, S11, S17

## Acceptance criteria
- [ ] Cap per-user concurrent turns, audio duration, upload size and request rate; bounded retries respect Retry-After.
- [ ] Trace IDs and timings contain no content/credentials; logs have configured retention.
- [ ] Deletion removes documents/chunks/embeddings/messages and provider-job remnants; failure is retriable.
- [ ] Provider data handling/retention unknowns and required agreement are documented before hosted deployment.

## Required test evidence
Load/error tests, log redaction assertions and deletion cascade integration tests.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S25: Document agent-only Cloudflare Free/Convex deployment and recovery

Labels: infra, story, blocked

## Goal
Document Cloudflare agent-only Free-plan configuration, Convex schema/data migrations, separate frontend-hosting boundary, health checks and rollback.

## Scope exclusions
No cloud account provisioning, secret insertion or production activation in this issue alone.

## Prerequisites
S01, S07, S12, S23, S24

## Acceptance criteria
- [ ] Secrets use deployment secret storage and are not bundled into client assets.
- [ ] Separate dev/staging/prod configuration and Convex auth provider callback allowlists. Convex Free must not be confused with metered Starter; record backend quotas, usage alerts and recovery. Verify Workers Free and SQLite-backed Durable Objects; quota exhaustion must not trigger billing upgrades.
- [ ] Describe Convex schema/data migrations, worker retries, private storage and Convex-authenticated agent entry points. Cloudflare hosts agents only; no Access gate or frontend hosting.
- [ ] Document backup/restore and rollback limitations; failed health checks block release.
- [ ] Restricted single-user deployment precedes any multiuser provider launch.

## Required test evidence
Deploy dry-run/config validation with fake values and runbook review.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S26: Verify v0.1 end-to-end release acceptance

Labels: test, story, blocked

## Goal
Exercise the complete learner journey and privacy boundaries before milestone close.

## Scope exclusions
Do not mark ready based only on unit tests or a text-only demo.

## Prerequisites
S05, S17, S19, S20, S21, S22, S23, S24, S25

## Acceptance criteria
- [ ] User A signs in, creates project, uploads doc and completes two spoken grounded turns.
- [ ] Language and concept modes both work, with transcript/citations and TTS playback.
- [ ] User B cannot access A data via UI/Convex functions/file actions/vector search/agent state/cache/audio.
- [ ] Microphone denial, provider 429/timeout, parser failure and cancellation recover without duplicate turns.
- [ ] Inspect actual desktop/mobile screenshots and microphone/playback behaviour in supported browsers.
- [ ] Release checklist records measured latency, known limits and remaining multiuser/realtime gates.

## Required test evidence
E2E report with synthetic fixtures, browser matrix, screenshots and opt-in provider smoke results.

## Delivery
One focused PR referencing this story. Include changed interfaces/schema/data migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.
