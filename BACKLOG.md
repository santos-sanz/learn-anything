# v0.1 development backlog

Draft publication package. 4 epics and 26 stories. Stable planning IDs are not GitHub issue numbers. Replace references after creation. A `blocked` label means declared prerequisites are not yet complete; the factory must remove it only after verification.

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
- [ ] Documents single-user NaN deployment and the hosted multiuser gate.
- [ ] Records web/API/worker interfaces and versioned configuration.

## Required test evidence
ADR review against official provider and runtime docs.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S03: Create reproducible Supabase local environment and migrations

Labels: backend, story, blocked

## Goal
Add local Supabase configuration and versioned baseline migrations.

## Scope exclusions
No production Supabase purchase or project provisioning.

## Prerequisites
S02

## Acceptance criteria
- [ ] Document local reset/start/stop and migrations.
- [ ] Enable required Postgres extensions with version checks.
- [ ] Seed only synthetic users/content and verify clean reset.

## Required test evidence
Run reset twice and migration drift check.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S04: Implement project and conversation data schema

Labels: backend, story, blocked

## Goal
Add projects, goals, sessions, messages and progress events with ownership constraints.

## Scope exclusions
No team sharing or billing.

## Prerequisites
S03

## Acceptance criteria
- [ ] FKs prevent records being attached to another owner/project.
- [ ] Create/update/delete lifecycle and indexes are documented.
- [ ] Server timestamps, message roles and stable turn IDs support idempotence.

## Required test evidence
Migration tests including invalid cross-owner relationships.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S05: Enforce RLS and private Storage tenant policies

Labels: security, story, blocked

## Goal
Add owner-based row policies and project-scoped private Storage rules.

## Scope exclusions
No service-role client in browser.

## Prerequisites
S04

## Acceptance criteria
- [ ] Anonymous access is denied to all private data.
- [ ] User A cannot SELECT/INSERT/UPDATE/DELETE user B rows or read/write B storage keys.
- [ ] Backend privileged paths check user and project ownership before use.
- [ ] Caches and search RPCs preserve tenant boundaries.

## Required test evidence
Two-user integration tests over tables, RPCs and signed storage links.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S06: Implement Supabase sign-in and verified API sessions

Labels: backend, story, blocked

## Goal
Build sign-in, sign-out, refresh, callback and session validation.

## Scope exclusions
No assumptions that Cloudflare replaces Supabase Auth.

## Prerequisites
S05

## Acceptance criteria
- [ ] Browser and server sessions work across refresh and expiry.
- [ ] Backend verifies current session/token using approved Supabase verification, not untrusted client user IDs.
- [ ] Errors do not disclose credentials; sign-out invalidates local session state.
- [ ] Redirect allowlist and CSRF/secure-cookie approach documented for chosen framework.

## Required test evidence
Auth integration tests for expired, forged and missing credentials.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S07: Add optional Cloudflare Access perimeter validation

Labels: infra, story, blocked

## Goal
Protect restricted deployments and validate Access JWT in backend in addition to Supabase identity.

## Scope exclusions
Do not force a closed Access allowlist onto an unconfigured public learner app.

## Prerequisites
S01, S06

## Acceptance criteria
- [ ] Issuer, audience, signature, expiry and key rotation are validated.
- [ ] Missing/forged Access tokens are denied when gate enabled.
- [ ] Direct-origin bypass is blocked and documented.
- [ ] Auth callbacks and preflight paths are tested; no mapping Access email directly to a trusted Supabase user.

## Required test evidence
Negative JWT tests and deployment checklist with gate on/off.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S08: Implement safe document uploads and metadata

Labels: backend, story, blocked

## Goal
Accept private PDF, Markdown and plain text documents with project-scoped metadata.

## Scope exclusions
No arbitrary URL ingestion or OCR in v0.1.

## Prerequisites
S05, S06

## Acceptance criteria
- [ ] Allowlist MIME/extension and validate file content with explicit configurable size limits.
- [ ] Reject malformed/unsupported/oversize documents and unsafe filenames.
- [ ] Uploads land in private project storage and produce one queued job.
- [ ] UI/API exposes pending/failed/ready state without content leakage.

## Required test evidence
Synthetic valid/invalid file fixtures and two-user upload tests.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S11: Add NaN adapters and document provider policy gate

Labels: ai, story, blocked

## Goal
Provide typed adapters for models, LLM streaming, embeddings, rerank, STT, translation and TTS.

## Scope exclusions
No pooling the deployer personal key across learners; no real provider calls in ordinary CI.

## Prerequisites
S02

## Acceptance criteria
- [ ] Base URL is https://api.nan.builders/v1; keys are server-side and redacted.
- [ ] Contract tests cover timeouts, 429, unsupported models, malformed payloads and cancellation.
- [ ] Separate nonstandard rerank endpoint from standard OpenAI client methods.
- [ ] Document personal non-transferable key terms and restrict initial live deployment to single user.
- [ ] Hosted multiuser credential custody/provider agreement is explicitly unresolved, not automatically solved by BYOK.

## Required test evidence
Mock contract tests plus opt-in smoke test instructions; record current official API/model/terms docs.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S12: Resolve 4096-dimension vector storage and indexing

Labels: ai, story, blocked

## Goal
Test qwen3-embedding dimensions and choose compatible storage/retrieval strategy in an ADR.

## Scope exclusions
Do not blindly create vector(4096) HNSW or silently truncate vectors.

## Prerequisites
S03, S10, S11

## Acceptance criteria
- [ ] Store embedding model/version/dimension with chunks; reject mismatched query vectors.
- [ ] Demonstrate exact search for a small synthetic corpus.
- [ ] Document HNSW limits: vector 2000 and halfvec 4000 according to Supabase docs; verify deployed extension version.
- [ ] Evaluate supported lower dimensions or quantized candidates plus full rerank before enabling ANN.
- [ ] Benchmark relevance and p95 latency with corpus size and hardware stated.

## Required test evidence
Migration test plus deterministic retrieval benchmark; ADR approves v0.1 strategy.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S13: Build scoped retrieval, reranking and citation contract

Labels: ai, story, blocked

## Goal
Retrieve only ready chunks in one owned project, rerank candidates and return bounded citation context.

## Scope exclusions
No corpus-wide search across tenants or unbounded prompt context.

## Prerequisites
S05, S10, S11, S12

## Acceptance criteria
- [ ] Owner/project filters are applied before retrieval, not only after.
- [ ] Returns stable document/chunk/page/heading IDs and supports deleted/missing sources.
- [ ] Empty corpus and low-confidence matches return explicit insufficient-evidence result.
- [ ] Context budget/top-k and optional rerank fallback are deterministic.

## Required test evidence
Two-user and two-project isolation tests plus gold-question relevance fixtures.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
- [ ] Audio uses authenticated or short-lived private delivery and is not committed/logged.
- [ ] Cancelling a turn stops playback and rejects stale audio.

## Required test evidence
UI tests for blocked autoplay, unsupported voice, errors and private audio access.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


## S25: Create Cloudflare/Supabase deployment and recovery runbooks

Labels: infra, story, blocked

## Goal
Document environment configuration, migrations, build/deploy, health checks and rollback.

## Scope exclusions
No cloud account provisioning, secret insertion or production activation in this issue alone.

## Prerequisites
S01, S07, S12, S23, S24

## Acceptance criteria
- [ ] Secrets use deployment secret storage and are not bundled into client assets.
- [ ] Separate dev/staging/prod configuration and auth redirect allowlists.
- [ ] Describe Supabase migrations, worker retries, private storage and origin protection.
- [ ] Document backup/restore and rollback limitations; failed health checks block release.
- [ ] Restricted single-user deployment precedes any multiuser provider launch.

## Required test evidence
Deploy dry-run/config validation with fake values and runbook review.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.


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
- [ ] User B cannot access A data via UI/API/RPC/storage/cache/audio.
- [ ] Microphone denial, provider 429/timeout, parser failure and cancellation recover without duplicate turns.
- [ ] Inspect actual desktop/mobile screenshots and microphone/playback behaviour in supported browsers.
- [ ] Release checklist records measured latency, known limits and remaining multiuser/realtime gates.

## Required test evidence
E2E report with synthetic fixtures, browser matrix, screenshots and opt-in provider smoke results.

## Delivery
One focused PR referencing this story. Include changed interfaces/migrations, tests and operational limits. Use synthetic fixtures only. No secrets or live account data. Do not provision paid resources or contact providers without separate authority.
