# S26 — v0.1 end-to-end release acceptance report

**Story:** S26 / issue #30 · **Branch:** `feat/issue-30-release-acceptance` · **Base:** `origin/main` at `a85d65b` (S05…S25 plus #41 auth hardening merged) · **Date:** 2026-10-03

This report is the S26 acceptance evidence: the full learner journey, both tutor
modes, the two-user privacy matrix, failure recovery without duplicate rows,
the browser/device inspection with screenshots, and the release checklist.
Everything below ran offline against the in-process Convex test deployment with
synthetic fixtures; the NaN provider layer is mocked. **No live provider call,
no paid quota, no secret and no production change was used, and this PR makes
no production code changes.**

> **Verdict:** every S26 acceptance criterion is addressed with evidence below,
> but this run does **not** issue a final "v0.1 accepted" sign-off — per PM
> review, prerequisites **#41 (closed, merged)** and **#38 (partially blocked
> on owner authority)** gate the milestone sign-off. The PR therefore opens
> with `Refs #30`, not `Closes #30`.

## Prerequisite status

| Prerequisite | Status | Evidence |
| --- | --- | --- |
| S05, S17, S19, S20, S21, S22, S23, S24, S25 (BACKLOG) | ✅ closed, merged | PRs #37, #66, #53, #55, #45, #52, #44, #69, #70 |
| #41 — Convex Auth hardening (PM-added) | ✅ **SATISFIED** — PR #71 merged, `main` = `a85d65b`; this branch merged it before the runs below | Negative-token tests across 13 `ctx.auth` functions + 5 HTTP routes (`packages/api/tests/auth-negative-tokens.test.ts`), 8-entry callback/redirect allowlist with foreign-origin rejection (`packages/api/tests/auth-callback.test.ts`), agent handshake binding guard with no email-only/user-ID-only binding (`packages/agent/tests/sessionEndpoint.test.ts`), ADR evidence table (`docs/adr/0004-authentication-method.md`) — all green in the `pnpm test` output below |
| #38 — Vercel deploy (PM-added) | ⛔ **partially blocked** — offline config/docs in flight (separate worktree); secrets workflow + production deploy + live sign-in smoke require **owner authority** (`Missing environment variable JWT_PRIVATE_KEY` in production QA) | Recorded as a remaining gate, not passed |
| #67, #68 (auth error copy, sign-in/onboarding screen) | ℹ️ out of S26 scope, listed as follow-ups (order-40/41, milestone v0.2) | issue tracker |

## Commands and outputs (this branch, post-#41 merge)

```text
$ pnpm lint
  → exit 0 (no findings)

$ pnpm typecheck
  → packages/agent, packages/api, packages/app, packages/shared, packages/worker: Done

$ pnpm test
  → Test Files  89 passed (89)
  → Tests      642 passed (642)          # includes the 43 new S26 tests below
  → + packages/agent runtime: Test Files 5 passed (5), Tests 10 passed (10)

$ pnpm build
  → all packages: Done
```

New S26 test files (all included in the run above):

| File | Tests | Criterion |
| --- | --- | --- |
| `packages/app/tests/e2e-release-journey.test.tsx` | 1 | AC1 full journey |
| `packages/app/tests/e2e-release-modes.test.tsx` | 1 | AC2 both modes |
| `packages/app/tests/e2e-privacy-matrix.test.tsx` | 35 | AC3 privacy matrix |
| `packages/app/tests/e2e-failure-recovery.test.tsx` | 6 | AC4 failure recovery |
| `docs/evidence/s26/browser-probe.mjs` + screenshots | — | AC5 browser/device |
| this report | — | AC6 release checklist |

Shared test-only helpers added: `packages/app/tests/helpers/releaseHarness.ts`
(dynamic-identity harness + real Convex Auth sign-in + no-duplicate invariant),
a scripted chat-behaviour extension to `tests/helpers/voiceConversation.ts`
(429/hang injection, system-prompt capture), and a realm/`subtle` fix in
`tests/jsdomCrypto.ts` so the real password provider runs under jsdom.

---

## AC1 — Full learner journey (User A)

Test: `packages/app/tests/e2e-release-journey.test.tsx` — **PASS**.
The deployment is `convex-test` in-process; the account is created and signed
into through the **real Convex Auth `signIn` action** (synthetic RSA key,
password hashed by the real provider); the provider layer is the offline NaN
mock (one deterministic SSE answer). The voice steps run in the same S17
`SpokenConversation` component the project screen hosts, bound to the journey's
project id and identity (ProjectDetail does not expose capture/playback
injection points; the seam is the component itself, not a fixture backend).

| # | Step | Result | Observable |
| --- | --- | --- | --- |
| 1 | Sign in (UI form → real `auth.signIn` action) | ✅ | sign-in view → dashboard; server shows 1 real user, `listProjects` = `[]`, subject owner == signed-up owner |
| 2 | Create project via UI (`Photosynthesis study`, Language practice) | ✅ | landed on `#/projects/<id>`, `h1` name, server row exists |
| 3 | Upload `three-page-lesson.pdf` via UI (real authenticated HTTP action) | ✅ | "uploaded — waiting to process" (server-true `queued`, never optimistic) |
| 4 | Real S09 ingestion cycle (parse → chunk → embed) | ✅ | `Ready · N sections`, `documentChunks > 0` |
| 5 | Spoken turn 1: capture → transcribe (HTTP STT) → retrieve/generate with citations → TTS playback | ✅ | stage track `listening → transcribing → generating → speaking → ready`; history shows transcript `what is photosynthesis`, answer with `[1]`, **citation link `1. …`**; 1 playback started and ended |
| 6 | Spoken turn 2: same pipeline from resting state | ✅ | history shows the transcript twice and 2 citation links; 2 playbacks total |
| 7 | Real app screen re-read (S21 project detail, server-backed history) | ✅ | `Conversation history` region: 2 learner transcripts, 2 tutor answers, 2 citation links |
| 8 | Server truth | ✅ | `tutorTurns` = 2 (all `completed`, distinct ids); `messages` = 4 (2 learner, 2 tutor); `citations` = 2; provider counts `chat=2, transcriptions=2, speech=2, embeddings=3` (1 batched ingestion call + 2 query embeddings); `expectNoDuplicateTurns` passes |

## AC2 — Both tutor modes with transcripts, citations and TTS playback

Test: `packages/app/tests/e2e-release-modes.test.tsx` — **PASS**.

| Mode | Spoken turn | Transcript + citations visible | TTS playback | Mode-specific server effect |
| --- | --- | --- | --- | --- |
| Language practice (S19, configured: es/beginner/immediate) | ✅ completes `ready` | ✅ history transcript + `1. …` citation link | ✅ 1 playback | ✅ captured system prompt contains `Language-practice mode (project settings;` + `Learning language: Spanish`; exactly **1 `practisedTopics` row** (`targetLanguage: es`) |
| Concept learning (S20, objective selected) | ✅ completes `ready` | ✅ history transcript + `1. …` citation link | ✅ 1 playback | ✅ captured system prompt contains `Project track: concept learning.`; `concept.runActivity` writes exactly **1 `progressEvents` row** (`activity-completed`, objective captured, its prompt contains the objective) |

Row truth across both modes: `tutorTurns` = 3 (all `completed`, distinct),
`messages` = 6, `citations` = 3, `practisedTopics` = 1, `progressEvents` = 1,
provider counts `transcriptions=2, speech=2, chat=3` — no duplicates.

---

## AC3 — Two-user privacy matrix (B vs A)

Test: `packages/app/tests/e2e-privacy-matrix.test.tsx` — **35/35 PASS**.
One shared deployment seeds A's world once (project + ingested document +
completed grounded turn + agent connection token). Every row below is an
individual named test; **actual = expected on every row**. "Denied" means the
typed non-enumerating error (`NOT_FOUND`/`UNAUTHENTICATED`/`404`) with zero
provider calls and zero rows written unless stated.

### Surface: UI

| # | Attempt (as B) | Expected | Actual |
| --- | --- | --- | --- |
| U1 | Open dashboard | A's project/goal absent | ✅ onboarding view, `queryByText("A private notes")` null |
| U2 | Open A's project detail deep link | non-enumerating denial, no name/goal | ✅ "doesn't exist or isn't yours", name absent |
| U3 | Open A's documents route | denied list, no filenames | ✅ "Couldn't load your documents", `lesson.md` absent |
| U4 | Open A's conversation (same project id, B identity) | history error, no transcript/answer/citations | ✅ "conversation history could not be loaded", 0 texts, 0 citation links |

### Surface: Convex functions

| # | Attempt (as B) | Expected | Actual |
| --- | --- | --- | --- |
| C1 | `projects.getProject` (A's project) | NOT_FOUND | ✅ |
| C2 | `projects.updateProject` | NOT_FOUND | ✅ |
| C3 | `projects.requestProjectDeletion` | NOT_FOUND | ✅ |
| C4 | `documents.listDocuments` | NOT_FOUND | ✅ |
| C5 | `documents.getDocument` | NOT_FOUND | ✅ |
| C6 | `documents.listDocumentStatuses` | NOT_FOUND | ✅ |
| C7 | `documents.retryDocument` | NOT_FOUND | ✅ |
| C8 | `documents.deleteDocumentBatch` | NOT_FOUND | ✅ |
| C9 | `files.getPrivateFile` (A's file) | NOT_FOUND | ✅ |
| C10 | `sources.getCitationSource` (A's chunk) | NOT_FOUND | ✅ |
| C11 | `tutor.getTranscript` | NOT_FOUND | ✅ |
| C12 | `tutor.getTurn` | NOT_FOUND | ✅ |
| C13 | `tutor.latestTurn` | NOT_FOUND | ✅ |
| C14 | `tutor.cancelTurn` | NOT_FOUND | ✅ |
| C15 | `tutor.runTurn` (action) | NOT_FOUND, 0 provider calls, 0 rows | ✅ |
| C16 | `ingestion.listIngestionJobs` | NOT_FOUND | ✅ |
| C17 | `agentSessions.issueConnectionToken` | NOT_FOUND | ✅ |
| C18 | `agentSessions.revokeConnectionToken` (A's token id) | NOT_FOUND | ✅ |
| C19 | `agentSessions.revalidateConnectionToken` (A's token) | CONNECTION_TOKEN_SCOPE | ✅ |
| C20 | `concept.getSelection` | NOT_FOUND | ✅ |
| C21 | `concept.listProgressEvents` | NOT_FOUND | ✅ |
| C22 | `concept.selectObjectiveAndDifficulty` | NOT_FOUND | ✅ |
| C23 | `concept.runActivity` (action) | NOT_FOUND | ✅ |
| C24 | `languagePractice.getLanguagePracticeConfig` | NOT_FOUND | ✅ |
| C25 | `languagePractice.listPractisedTopics` | NOT_FOUND | ✅ |
| C26 | `languagePractice.updateLanguagePracticeConfig` | NOT_FOUND | ✅ |
| C27 | anonymous `projects.getProject` | UNAUTHENTICATED | ✅ |
| C28 | anonymous `tutor.getTranscript` | UNAUTHENTICATED | ✅ |

### Surface: vector search / retrieval

| # | Attempt (as B) | Expected | Actual |
| --- | --- | --- | --- |
| V1 | `embeddings.searchProjectVectors` (A's project) | NOT_FOUND before any search | ✅ |
| V2 | `retrieval.retrieveProjectContext` (A's project) | NOT_FOUND before any search | ✅ |
| V3 | forged client `scopeKey: "learner-a:<project>"` argument | rejected as an unexpected argument (server derives scope) | ✅ validator rejection |
| V4 | A's own retrieval (positive control) | `status: "ok"` (denial is not vacuous) | ✅ |

### Surface: HTTP file actions

| # | Attempt | Expected | Actual |
| --- | --- | --- | --- |
| H1 | B `POST /private-uploads` into A's project | 404, no blob stored | ✅ 404, `privateFiles` unchanged |
| H2 | B `GET /private-files/<A's fileId>` | 404 (no bytes) | ✅ 404 |
| H3 | anonymous `GET /private-files/<id>` | 401 | ✅ 401 |

### Surface: HTTP STT / TTS actions

| # | Attempt | Expected | Actual |
| --- | --- | --- | --- |
| S1 | B `POST /stt/transcribe` on A's project | 404 `{code:"NOT_FOUND"}`, 0 transcriptions | ✅ |
| S2 | B `POST /tts/synthesize` on A's turn | 404, 0 speech calls | ✅ |
| S3 | anonymous STT | 401 | ✅ |
| S4 | anonymous TTS | 401 | ✅ |

### Surface: agent connection state

| # | Attempt | Expected | Actual |
| --- | --- | --- | --- |
| A1 | B issues a token for A's project | NOT_FOUND | ✅ |
| A2 | B revokes A's token id | NOT_FOUND | ✅ |
| A3 | B revalidates A's token | CONNECTION_TOKEN_SCOPE | ✅ |
| A4 | B `revokeAllConnectionTokens` | touches only B's rows — A's token still verifies | ✅ verify → 200, `ownerId: "learner-a"` |
| A5 | forged 64-hex token to `POST /agent/connection-tokens/verify` | 401 `CONNECTION_TOKEN_INVALID` | ✅ (the verify route is token-scoped by design: the token is the credential, hash-stored, TTL-bound, rotation on reconnect, scope-checked whenever bound to a caller identity) |

Agent runtime gate (workerd): `packages/agent/tests/gate.test.ts`,
`tests/runtime/isolation.test.ts` ("refuses user two's valid token on user
one's instance at the gate" → 403 `AGENT_SCOPE_MISMATCH`,
`tests/runtime/connection.test.ts`) — run green in `pnpm test` →
`pnpm --filter @learn-anything/agent test:runtime`.

### Surface: caches / telemetry

| # | Attempt | Expected | Actual |
| --- | --- | --- | --- |
| T1 | B's denied STT + transcript attempts | 0 telemetry rows for `learner-b` | ✅ 0 rows |
| T2 | rows keyed to A's project | all `ownerId: learner-a` | ✅ |
| T3 | redaction canary (`what is photosynthesis`, answer text) | absent from every telemetry row | ✅ |
| T4 | rate-limit buckets | none for B, never A's bucket | ✅ |
| T5 | public read surface for telemetry | none (source scan: module exports no public `query`/`mutation`/`action`) | ✅ |

Cross-user rate-limit bucket isolation and the "denied even with a fresh
bucket" handler path are additionally covered by
`packages/api/tests/rate-limits.test.ts` (buckets per learner+route, foreign
projectId → no scope); telemetry allowlist/redaction/retention by
`packages/api/tests/telemetry.test.ts`. The client-side audio cache is
per-player-instance (no cross-mount reuse), and B's player request for A's
turn is a typed `not-found` (row A6 below) — never A's bytes.

### Surface: audio

| # | Attempt | Expected | Actual |
| --- | --- | --- | --- |
| AD1 | A fetches her own tutor audio | 200 `audio/mpeg`, `cache-control: private, no-store`, `x-content-type-options: nosniff`, bytes present | ✅ (1 speech call) |
| AD2 | B fetches A's audio (same URL) | 404, provider speech count unchanged (no synthesis for B) | ✅ count stays 1 |
| AD3 | B's player client (`requestTtsAudio`) | typed `{ok:false, code:"not-found"}`, no bytes | ✅ |

Static control: "no Convex module ever exposes a `storage.getUrl` bearer link"
(`packages/api/tests/document-uploads.test.ts`) — still green.

---

## AC4 — Failure recovery without duplicate turns

Test: `packages/app/tests/e2e-failure-recovery.test.tsx` — **6/6 PASS**.
Row counts are asserted after every scenario; the shared invariant
`expectNoDuplicateTurns` requires unique turn ids, ≤1 learner + ≤1 tutor
message per turn, and unique message idempotency keys.

| # | Scenario | Injection | Recovery path exercised | Row counts proving no duplicates | Result |
| --- | --- | --- | --- | --- | --- |
| F1 | Microphone denial | device layer throws `NotAllowedError` once (server never reached) | visible denial ("Microphone permission was denied…") → panel **Try again** → full turn | denial: `tutorTurns` 0, `messages` 0 → recovery: **1 completed turn, 2 messages** | ✅ |
| F2 | Provider 429 (single) | first `/chat/completions` answers 429 + `Retry-After: 0` | in-action retry inside the same turn (`chat` calls = 2) | **1 completed turn, 2 messages** | ✅ |
| F3 | Provider 429 (persistent) | three 429s exhaust the attempt budget → `TURN_RATE_LIMITED` | visible failure + copy "The tutor is rate limited…"; UI **Retry** (fresh id, terminal) → `chat` calls = 4 | **2 turn rows (1 `failed`, 1 `completed`), distinct ids, 2 messages all on the completed turn, failed turn owns 0 messages** | ✅ |
| F4 | Provider timeout | first chat hangs; `TUTOR_TIMEOUT_MS=100` → `NAN_TIMEOUT`/`TURN_TIMEOUT` | in-action retry (`chat` calls = 2) | **1 completed turn, 2 messages** | ✅ |
| F5 | Parser failure | job/document patched to the real runner's `PARSE_FAILED` outcome state (a genuinely failing parse cannot be reproduced deterministically offline — see limits) | `documents.retryDocument` re-arms **once** (second call `retried:false`), real `runIngestionCycle` re-parses and re-embeds, document → `ready`, then a spoken turn completes | `ingestionJobs` **1** throughout (never duplicated); `documentChunks` **byte-identical `_id` set** before/after; `messages`/`tutorTurns` unaffected (0) → post-recovery turn **1 completed, 2 messages** | ✅ |
| F6 | Cancellation while generating | provider chat hangs; `TURN_CANCEL_POLL_MS=50`; UI **Cancel turn** | server cancel watcher aborts the in-flight action | after cancel: **1 `cancelled` turn, 0 messages, 0 citations** → fresh turn: **2 turn rows total (1 cancelled, 1 completed), 2 messages** | ✅ |

Supporting (already on main, re-run in this branch): retryable-failure
backoff/dead-letter and lease-crash resume with identical chunk `_id`s
(`packages/api/tests/ingestion-jobs.test.ts`), dead-letter re-arm idempotency
(`document-management.test.ts`), provider-retry under one turn id and
cancellation leaving zero messages (`tutor.test.ts` cases (d)/(e)), concept
activity cancellation (`concept.test.ts`), client bounded 429 retry loop
(`packages/app/tests/retry-after.test.ts`).

---

## AC5 — Browser / device inspection

**Runner:** system Google Chrome **154.0.8037.93** driven by Playwright 1.63
(`channel: "chrome"`, headless) on macOS. Screenshots captured from the DEV
preview fixtures (synthetic data only; `vite build` strips them).

### Screenshot matrix (inspected — images open and verified)

| File | Viewport | What was inspected |
| --- | --- | --- |
| `journey-dashboard-desktop.png` / `-mobile.png` | 1280×1000 / 390×844 | dashboard with projects, modes badges, no overflow at 390 px |
| `journey-documents-desktop.png` / `-mobile.png` | 1280×1000 / 390×844 | upload form + per-job badges (`Ready · 6 sections`, `Processing… (attempt 1 of 5)`, encrypted/failed states) |
| `journey-transcripts-citations-desktop.png` / `-mobile.png` | 1280×1000 / 390×844 (full page) | **learner transcript, tutor answer with `[1]`/`[2]` and citation links `1. Page 2`, `2. Practice routine`**, all five stages, Ready reached |
| `journey-failure-recovery-desktop.png` / `-mobile.png` | 1280×1000 / 390×844 (full page) | failed stage (`Retrieving & generating — failed`), typed alert "The tutor timed out. Retry (starts a new turn) — no duplicate answer can be created.", Retry / Discard response, editable transcription |
| `journey-citation-source-desktop.png` / `-mobile.png` | 1280×1000 / 390×844 | citation source viewer with cited chunk |

Reproduce:

```sh
pnpm --filter @learn-anything/app exec vite --port 5216 --strictPort &
npx playwright screenshot --channel=chrome --viewport-size="1280,1000" --full-page \
  --wait-for-timeout=2500 "http://localhost:5216/#/preview/conversation-ready" \
  journey-transcripts-citations-desktop.png
# 390,844 and the other routes: #/projects, #/preview/documents,
# /preview/conversation-error, #/preview/source
```

### Microphone / playback probe (real browser)

`docs/evidence/s26/browser-probe.mjs` (synthetic media only — Chrome's fake
device and a locally generated WAV; nothing leaves the machine). Observed
output on this host:

```json
{
  "chrome": "154.0.8037.93",
  "deny":    { "granted": false, "name": "NotAllowedError" },
  "playback":{ "objectUrl": true, "state": "playing", "currentTime": 0.25, "paused": true, "duration": 0.25 },
  "grant":   { "error": "timeout: getUserMedia grant did not settle in 15s" }
}
```

| Capability | Browser | Result |
| --- | --- | --- |
| `getUserMedia` **denied** (permission withheld) | Chrome 154 headless | ✅ **verified**: immediate `NotAllowedError` — matches the app's `permission-denied` classification exercised in F1 |
| `getUserMedia` **granted** via `--use-fake-device-for-media-stream` | Chrome 154 headless | ⛔ **not verifiable on this host**: fake audio source fails (`NotReadableError: Could not start audio source`), hangs, or kills the renderer — reproduced with default flags, `--use-file-for-fake-audio-capture`, and audio-service flag variants (`AudioServiceOutOfProcess`, `AudioServiceSandbox`, in-process). **Remaining gate.** |
| `MediaRecorder` capture of granted audio | Chrome 154 headless | ⛔ blocked by the grant failure above — **remaining gate** |
| `<audio>` playback of a synthetic WAV after a **trusted click** | Chrome 154 headless | ✅ **verified**: `state: playing`, `currentTime` advanced to the full 0.25 s duration (autoplay without gesture is intentionally not attempted — spec behaviour) |
| App handling of grant/deny/recovery states | jsdom component harness | ✅ `turn-controller.test.ts` (denial/no-mic/unsupported states), `turn-capture-panel.test.tsx` (actionable copy + Try again), F1 E2E above |
| Firefox / WebKit / mobile Safari-Chrome | — | ⛔ only system Chrome is installed; no other engine exercised — **remaining gate** |

---

## AC6 — Release checklist

### Measured latency (re-measured on this branch; no production code changed)

Method (unchanged, `docs/spoken-conversation.md` §"Latency method and release
budget"): 40 turns through the real conversation machine, fake clock,
mulberry32 seed `20261003`, fixed per-stage envelopes, providers mocked.
`npx vitest run packages/app/tests/latency-budget.test.ts` → **3/3 passed**,
i.e. recorded percentiles equal the sample's own percentiles and p95 stays
inside budget. Sample percentiles re-derived independently for this report:

| Stage | p50 | p95 | Budget (p95 ceiling) | Within budget |
| --- | ---: | ---: | ---: | --- |
| permission | 26 ms | 48 ms | 150 ms | ✅ |
| transcribe | 494 ms | 840 ms | 1 500 ms | ✅ |
| generate | 1 360 ms | 2 834 ms | 4 000 ms | ✅ |
| speak (answer → playing) | 676 ms | 1 310 ms | 2 000 ms | ✅ |
| **end-to-end (stop → playing)** | **2 533 ms** | **4 157 ms** | **7 000 ms** | ✅ |
| listening (learner, recorded only) | 1 385 ms | 1 845 ms | not budgeted | — |

These are **synthetic-envelope measurements, not NaN latency** — live provider
latency must be re-measured with an opt-in smoke run (separate authority)
before release, and the envelopes/budget re-derived from it.

### Known limits (deferred nits recorded in merged PRs)

- **#66 (S17):** (a) starting a new turn from an *ambiguous* `error` does not
  send `cancelTurn` for a possibly-still-running server turn; (b) the
  `SCREAMING_SNAKE` token fallback classifies unknown tokens as terminal
  (opposite of the "default to ambiguous" rule); (c) `LatencyRecorder` only
  records turns that fully played, biasing live p50/p95 toward played-out
  turns. All three are recorded, non-blocking review nits.
- **#40:** no password recovery in this build (needs an email provider);
  Convex Auth is beta; no rate limiting on the agent verify/reconnect routes.
- **#43:** NaN access is single-user (`NAN_DEPLOYER_ID`); no browser client
  for the agent protocol.
- **#44/#54:** real-device microphone smoke and real-browser autoplay/audio
  element behaviour were unverifiable offline (reconfirmed by the probe above).
- **#51/#52/#53:** no client-visible incremental streaming (→ #62), documents
  auto-refresh is a 1.5 s poll, concept/language configuration has no UI yet.
- **#69:** a retained ≤1 h access token can act on a deleted account id until
  expiry; the rate limiter fails open by design; OGG/live-WebM duration falls
  back to the byte cap.
- **#70:** no backup cron; frontend hosting undecided in ADR-0001 (Vercel
  work tracked in #38); quotas checked 2026-10-02/03 and must be re-verified
  per deployment.

### Remaining gates (block v1.0, not this offline acceptance)

| Gate | Why it is still open |
| --- | --- |
| Live provider smoke (opt-in, paid quota) | NaN chat/embedding/STT/TTS never called here; needs separate authority per `docs/nan-provider-policy.md` |
| Real-device microphone + fake-device capture | see AC5 grant failure; real hardware/OS permission prompts unobserved |
| VAD / full duplex / barge-in / streaming | explicitly out of v0.1 (`README.md`, `docs/spoken-conversation.md` §Latency; issues #62/#63/#64 blocked) |
| Multiuser provider launch | blocked after runbook step 6 until provider terms + credential-custody model exist in writing (`docs/deployment-runbook.md` §10, `docs/provider-data-handling.md`) |
| Deployment health gates G5–G9 | need a live deployment under deployment authority (`docs/deployment-runbook.md` §6) |
| #38 live completion | secrets workflow (JWT_PRIVATE_KEY), production deploy, preview/production sign-in smoke — **owner authority required** |
| Browser matrix beyond Chrome | Firefox/WebKit engines not installed on this host |

---

## What was NOT verifiable offline (explicit)

1. **Real microphone hardware behaviour** — OS permission prompt UX, device
   enumeration, echo cancellation, real ambient audio. Only the *denial*
   outcome was observed in a real browser (`NotAllowedError`); the *grant*
   outcome could not be produced on this host (fake device broken), so grant +
   `MediaRecorder` encoding remain a gate.
2. **Live provider calls** — real Whisper transcription quality, real Kokoro
   speech, real LLM answers, real rerank, and real NaN latency/quota
   behaviour. All provider interactions here are the offline mock.
3. **A real deployed environment** — Convex production, Cloudflare agent
   runtime on the live Workers Free plan, Vercel hosting, live Convex Auth
   (JWT_PRIVATE_KEY), health gates G5–G9.
4. **Autoplay without a user gesture** — not attempted (browser spec blocks
   it); playback verified only behind a trusted click.
5. **Non-Chrome browsers and real mobile devices** — only system Chrome 154
   plus the jsdom harness ran; 390 px is a viewport emulation, not a device.
6. **Deterministic reproduction of a genuinely failing parser** — the
   `PARSE_FAILED` job state in F5 is injected at the runner's own outcome
   record; the failure→backoff→dead-letter classification itself is covered
   by a real storage failure through the real cycle
   (`ingestion-jobs.test.ts`), and parser error codes are covered by
   `packages/worker/tests/ingestion.test.ts`. A real slow/corrupt parse that
   recovers to success requires changed input and cannot be timed reliably
   offline.
7. **Multiuser operation** — B's identity is a second synthetic learner in
   one deployment; true multiuser launch is gated above.
8. **Text-only demo substitution** — explicitly not used: AC1/AC2 run the
   real screens, real HTTP actions, real ingestion and real turn pipeline
   against the real authorized functions with row-count assertions.

## Evidence index

```text
docs/evidence/s26/README.md                          this report (AC1–AC6)
docs/evidence/s26/journey-*-desktop.png (5)          desktop screenshots, inspected
docs/evidence/s26/journey-*-mobile.png  (5)          mobile screenshots, inspected
docs/evidence/s26/browser-probe.mjs                  real-browser mic/playback probe
packages/app/tests/e2e-release-journey.test.tsx      AC1 journey trace
packages/app/tests/e2e-release-modes.test.tsx        AC2 modes
packages/app/tests/e2e-privacy-matrix.test.tsx       AC3 matrix (35 rows)
packages/app/tests/e2e-failure-recovery.test.tsx     AC4 recovery (6 scenarios)
packages/app/tests/helpers/releaseHarness.ts         shared S26 harness (test-only)
```
