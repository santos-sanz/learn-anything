# Spoken conversation state machine (S17)

v0.1's core experience is one explicit machine in `packages/app`:

```
listening → transcribing → retrieving/generating → speaking → ready
```

with a single `error` state that always names the stage that failed, plus
retry and cancel at the points where they are meaningful. This document is
the delivery contract for that machine: its states, its turn-id rules, its
reconnect behaviour, its latency method and release budget, and its
operational limits.

**Scope:** single-turn push-to-talk. Continuous VAD, full duplex, barge-in
and realtime provider speech APIs are out of scope for v0.1 (per BACKLOG
S17), and the machine does not model them: there is exactly one capture
cycle per turn, a new capture cycle always supersedes the current turn, and
no state pretends a microphone session survives a reload.

## The machine

State and transitions live in `packages/app/src/conversationState.ts` as a
pure reducer (`reduceConversation`), driven by
`packages/app/src/conversationController.ts`, which composes the S15 capture
controller, the S14 turn port and the S16 player controller. Every
transition is locked by `packages/app/tests/conversation-state.test.ts`;
events that belong to another turn (`turnId` mismatch) or another stage are
ignored, so a late transcript, a late tutor answer or late audio can never
move a newer turn backwards.

| Stage | Entered when | Visible controls |
| --- | --- | --- |
| `ready` | Initial state; after playback ends, a stop, a cancel or a discard | The S15 panel's record button; the finished answer with its player (Play/Pause/Stop, language picker) |
| `listening` | Record pressed: permission request and recording | S15 panel: clock, Stop and transcribe, Cancel turn |
| `transcribing` | Recording stopped: audio check + STT round trip | S15 panel: Cancel |
| `generating` | Transcript handed to `runTurn` (auto for the `transcribe` action) | `Cancel turn`, `New turn`; transcript stays editable below |
| `speaking` | `runTurn` committed; TTS fetch + playback started | `Stop speaking`, `New turn`; S16 player controls on the answer |
| `error` | Any stage failed; `failedStage` says which | Retry (stage-specific) + a way out (`Discard response`); capture-stage errors keep the S15 panel's own *Try again* |

The always-visible stage track (`ConversationStageTrack`) renders all five
steps with a state word — `done`, `in progress`, `failed`, `waiting`
(`reached` for the resting `ready` step) — and one `role="status"` /
`role="alert"` line with the current message. Stage state, error copy and
the action bar are pure functions (`conversationStageStates`,
`conversationMessage`, `conversationActions`).

### Retry and cancel, per stage

| Failed / active stage | Retry does | Cancel does |
| --- | --- | --- |
| `listening` (permission, codec, no device) | Record again (S15 panel) | Discards the recording, back to `ready` |
| `transcribing` (silence, timeout, 429, network…) | Record again — raw audio was already discarded by design (S15) | Aborts the in-flight STT request, back to `ready` |
| `generating` | Re-sends the (possibly edited) transcript under the turn-id rule below | `cancelTurn` (S14) + local token bump; the late answer is dropped, zero messages written |
| `speaking` (TTS 429/timeout, playback fault) | Replays the same turn id — the TTS route is a read of the committed answer | `Stop speaking` keeps the answer; `Discard response` clears it |

### Turn id end to end (no duplicate turn)

One turn id is minted when the recording is sent to STT and the **same id**
travels to `runTurn` and to TTS, so S14's idempotency covers the whole turn:

- **Ambiguous failure** (connection dropped after the request may have
  started, or `TURN_IN_PROGRESS` / `TURN_ATTEMPT_LOST`): the retry reuses the
  same id — `beginTurn` replays a `completed` row or reports the live one, so
  a retry can never double-send. Locked by
  `conversation-controller.test.ts` ("retries with the SAME turn id and
  replays the stored answer") and the two-turn E2E's replay assertion.
- **Typed terminal failure** (`TURN_TIMEOUT`, `TURN_NOT_CONFIGURED`, auth
  errors…): that row is terminal with **zero messages**, so the retry mints a
  fresh id. Locked by the "FRESH turn id" test.
- A client-side guard rejects a second in-flight `runTurn` for the same
  logical attempt, and the reducer rejects any result whose `turnId` is not
  the current one.
- The two-turn E2E proves the server side: after two full turns there are
  exactly two `tutorTurns`, four messages, one provider round trip per stage
  per turn, and re-sending turn 1's `runTurn` returns `replayed: true` with
  no new rows and no provider call.

### Stop speech / start a new turn (stale results never play)

Starting a capture cycle from any stage first runs the supersede path in the
controller: the generation token is bumped, the server turn is cancelled if
one is running (S14 `cancelTurn`), the player is disposed (audio stops, its
own generation token invalidates in-flight TTS bytes), and the restore poll
is stopped. Any continuation that still belongs to the old token is dropped.
Covered by:

- "a late answer after a NEW turn started is rejected" (old answer arrives
  after turn 2 started → still listening, zero playback, cancel called once);
- "late audio for the previous turn is dropped when a new turn starts"
  (TTS bytes arrive after the new turn → no audio element ever sees them);
- the UI test "stopping speech and starting a NEW turn hides the old answer
  until the new one lands";
- `playerState.test.ts` / `response-player.test.tsx` for the S16-side
  generation guard itself.

## Reconnect: transcripts and citations survive

Nothing durable lives in the browser. On mount the machine restores from the
authorized server reads (`ConversationBackend`):

- `tutor.getTranscript` (re-validated citations) → the history panel;
- `tts.speechOptions` → the configured voice/language catalog;
- `tutor.latestTurn` → the newest turn's status:
  - `running` → the machine re-enters `generating` with `restorePolling` and
    polls `latestTurn` every second (≤60 attempts, the S14 60 s lease
    window). A completed turn speaks (autoplay-blocked degrades to the Play
    button), a failed turn restores its `failureCode` as a visible error with
    Retry (same turn id — idempotent), a cancelled turn restores a notice.
  - `completed` → the stored answer is restored as the playable response.
- The history panel also refetches after every generation/cancel and stays
  rendered during every stage, including `listening`.

Covered by `conversation-reconnect.test.tsx` (real upload → real ingestion →
real grounded turn → fresh mount restores transcript **and** the citation
link → history still visible while a new recording runs) and the controller
restore suite.

## Latency method and release budget

**Everything is offline.** No live STT/TTS/LLM request is ever made to
record these numbers (repository constraint: no provider calls in tests/CI).

### The documented synthetic sample

`packages/app/tests/latency-budget.test.ts` drives **40 turns** through the
real `ConversationController` on a fake clock. One deterministic draw per
stage (mulberry32, seed `20261003`) from fixed envelopes:

| Quantity | Envelope | Meaning |
| --- | --- | --- |
| permission | 0–50 ms | Record press → microphone ready |
| listening | 800–2000 ms | Learner speaking time (recorded, **never budgeted**) |
| transcribe | 150–900 ms | Stop → transcript (audio check + STT round trip) |
| generate | 400–3000 ms | Transcript → committed answer (retrieval + generation) |
| speak | 120–1500 ms | Committed answer → audio playing (TTS fetch + playback start) |

The envelopes are engineering placeholders for the mocked providers — they
are **not** measurements of NaN. Live provider latency must be re-measured
with an opt-in smoke run (separate authority) before release and the
envelopes/budget re-derived from it; that limitation is deliberate
(no paid quota in CI).

### Recorded numbers (measured, then asserted)

Stage boundaries are taken by `LatencyRecorder` inside the machine itself;
the test asserts the recorded p50/p95 **exactly equal** the sample's own
percentiles (so the recorder provably measures the documented spans, with no
hidden client work added to any stage) and that every p95 is inside the
budget:

| Stage (system-controlled) | p50 | p95 | Release budget (p95 ceiling) |
| --- | ---: | ---: | ---: |
| permission | 26 ms | 48 ms | **150 ms** |
| transcribe | 494 ms | 840 ms | **1 500 ms** |
| generate | 1 360 ms | 2 834 ms | **4 000 ms** |
| speak (answer → playing) | 676 ms | 1 310 ms | **2 000 ms** |
| **end-to-end (stop → playing)** | **2 533 ms** | **4 157 ms** | **7 000 ms** |
| listening (learner time, recorded only) | 1 385 ms | 1 845 ms | not budgeted |

Budgets (`RELEASE_LATENCY_BUDGET_MS` in `packages/app/src/latency.ts`) are
the measured p95 with headroom (≈1.4–1.8×, rounded); they are enforced by
`latency-budget.test.ts`, so a future change that widens a stage boundary
fails CI instead of silently growing the budget. The sample definition
(size, seed, envelopes) and the budget table are pinned by the same file.

## Changed interfaces

- **`packages/app/src/data/conversation.ts` (new):** `ConversationBackend`
  extends the S16 `TutorBackend` with `runTurn`, `getTurn` and `transcript`;
  `makeConvexConversationBackend` binds them to the existing authorized
  Convex functions (`tutor.runTurn`, `tutor.getTurn`, `tutor.getTranscript`).
- **`packages/app/src/SpokenConversation.tsx` (new):** the assembled
  surface — stage track, S15 capture panel, S16 player, history. Optional
  `capture` / `playback` / `onControllerReady` / `defaultAction` props are
  for tests and DEV previews; production builds the browser environments
  from `packages/app/src/environments.ts`.
- **Removed:** `packages/app/src/TurnCapture.tsx` — its container logic
  moved into `SpokenConversation` (the pure `TurnCapturePanel` and the S18
  translation flow are unchanged, and their tests still pass untouched).
- **`Root` / `ProjectDetail` / `App`:** the `tutor` prop is now a
  `ConversationBackend`; `TutorResponseSection` remains the S16 fixture
  surface used by its direct tests and the `#/preview/player-*` evidence.
- **No Convex schema, validator or function change.** S17 reads and calls
  the S14/S15/S16 surface as published; `SCHEMA_VERSION`/`FUNCTION_VERSION`
  and the bootstrap marker are untouched. Rollback is a plain code rollback.

## Operational limits

- Recording ≤60 s and ≤8 MiB (S15 constants), raw audio discarded after
  processing or abort; audio is request-scoped and never stored.
- One capture cycle per turn; no VAD, no duplex, no realtime APIs.
- Restore polls `latestTurn` at 1 s for at most 60 attempts; the S14 turn
  lease is 60 s. Polling stops the moment the learner starts a new turn.
- History reads use `tutor.getTranscript` (≤200 messages per page, newest
  first, citations re-validated server-side; `droppedCitations` is shown).
- The latency window keeps the most recent 200 completed turns.
- Cancel is best-effort client + server: the local token bump and player
  disposal take effect immediately; if the `cancelTurn` mutation itself
  fails, the server row keeps its authoritative state and the next history
  load shows it (same semantics as the S16 cancel).
- Provider policy (S11 single-user gate) and authorization (S05/S06) are
  unchanged: every port hits the same identity-checking functions.

## Test evidence map

| Requirement | Test |
| --- | --- |
| Stage transitions, stale-event rejection, tracker/actions/copy | `tests/conversation-state.test.ts` |
| Two turns without duplicates, capture-only mode | `tests/conversation-controller.test.ts` |
| Same-id replay / fresh-id retry (idempotency) | `tests/conversation-controller.test.ts` |
| Cancel mid-generation, late answer, late audio, stop+new turn | `tests/conversation-controller.test.ts` |
| Restore (completed / running / failed / history error) | `tests/conversation-controller.test.ts` |
| Stage visibility, status lines, Retry/Cancel UI, history while listening | `tests/spoken-conversation.test.tsx` |
| End-to-end two-turn voice through the real STT/runTurn/TTS functions | `tests/e2e-two-turn-voice.test.tsx` |
| Reconnect keeps transcripts + citations (real ingestion) | `tests/conversation-reconnect.test.tsx` |
| Sample, p50/p95 recording, release budget gate | `tests/latency-budget.test.ts` |
| Stage screenshots (desktop + mobile) | `docs/evidence/s17/` |
