# Provider data handling: what is known, unknown and must be agreed (S24)

Checked 2026-10-03 against the recorded source material only —
[NaN API examples](https://nan.builders/docs/examples),
[NaN model limits](https://nan.builders/docs/models),
[NaN terms](https://nan.builders/terms) as already transcribed in
`docs/nan-provider-policy.md` and `README.md`. This file is documentation
only: **no provider was contacted, no agreement was requested and no live API
call was made for this story.** Hosted multiuser deployment stays blocked
until the "must be agreed" list below is satisfied in writing; the single-user
self-hosted gate in `packages/worker/src/nan/` and the S11 policy checks remain
the enforcement in code.

## What this system sends to the provider

Every stage goes to NaN Builders (the fixed base URL
`https://api.nan.builders/v1`), server-side only, behind the personal-key
policy gate:

| Stage | Data that leaves this deployment | Where it lives afterwards (this side) |
| --- | --- | --- |
| Whisper STT (`/stt/transcribe`) | Raw microphone bytes for one turn | Never stored: request-scoped, discarded after the attempt; only the returned transcript enters the `messages` table |
| Whisper audio-to-English (`/translation/audio`) | Raw microphone bytes for one turn | Never stored; only the English translation text |
| Text translation (`/translation/text`) | The source text of one explicit request | Not stored by the translation route; only the result the learner sees |
| Tutor/translation LLM (`/chat/completions`) | Learner turn text, bounded history (≤6 messages/2,000 chars), retrieved document excerpts (≤6,000 chars) and the fixed system instruction | Learner/tutor messages and citations in `messages`/`citations`; the provider receives document excerpts only for the turn that cites them |
| Embeddings (`/embeddings`) | Chunk text (ingestion) and the learner's query text (turn) | 4096-dimension vectors in `chunkEmbeddings`; chunks already stored in `documentChunks` |
| Rerank (`/rerank`) | The query plus the candidate chunk texts already in the project | Nothing new; rerank output only reorders citations |
| Kokoro TTS (`/audio/speech`) | The stored tutor answer text of one owned turn | Nothing stored: audio is streamed to the browser and never written to storage |

Provider keys, deployment credentials and the `NAN_DEPLOYER_ID` gate stay in
server-side deployment configuration; they are never logged, never returned to
the browser and never present in telemetry (S24 stores only ids, timings and
allowlisted failure codes).

## What is known about our own retention

- Documents and chunks live until the learner or an account deletion removes
  them; S08/S22 and S24's bounded cascades delete documents, blobs, chunks,
  embeddings, messages, citations, turns, progress events, telemetry and agent
  tokens together (see `docs/convex-development.md`, S24).
- Telemetry holds ids and timings only, retained `LOG_RETENTION_DAYS`
  (default 30 days) and rotated hourly in bounded batches.
- Rate-limit buckets hold owner/route/window/count and live until account
  deletion.
- Raw audio is ephemeral by default on this side: it is never written to
  `ctx.storage` or any table, and the browser discards its recording after the
  attempt (README "Project and data boundaries").
- NaN's recorded terms make API keys personal and non-transferable; the only
  permitted initial deployment is self-hosted/single-user with the deployer's
  own server-side key, and hosted multiuser use is code-blocked
  (`docs/nan-provider-policy.md`).

## What is unknown (must not be assumed)

The recorded material does **not** establish any of the following, and none of
it may be assumed from the fact that requests succeed:

1. **Provider-side retention.** Whether NaN retains request payloads
   (audio bytes, prompts, chunk texts), responses, or metadata, and for how
   long.
2. **Training or model-improvement use.** Whether inputs or outputs are used
   to train or evaluate models.
3. **Logging and diagnostics.** What request bodies, headers or identifiers
   appear in provider logs, and who can access them.
4. **Sub-processors and residency.** Which downstream processors touch the
   data and in which jurisdictions it is stored or processed.
5. **Deletion guarantees.** Whether a provider-side deletion can be requested,
   honoured within a stated window, and verified.
6. **Breach notification.** Whether and when the deployer would be told about
   an incident involving this data.
7. **Embedding/vector handling.** Whether stored embeddings or the texts they
   derive from are retained beyond the request.
8. **Duration semantics.** The STT response's `duration` field is not
   documented with a unit by the recorded contract, so S24 enforces the audio
   budget from the container header and the byte cap instead of trusting that
   field.
9. **Undeclared container durations.** OGG and live WebM recordings without a
   Segment Duration cannot be length-checked server-side beyond the 8 MiB byte
   cap and the browser's 60-second recording budget.

Anything in this list that later turns out badly is a finding for a new issue,
not a silent assumption.

## What must be agreed before hosted (multiuser) deployment

Hosted deployment remains blocked until all of the following exist **in
writing with the provider**, and are recorded in this repository before any
code change lifts the single-user gate:

1. **A data-processing agreement** covering the payload classes in the table
   above, with a stated purpose limitation for each stage.
2. **Retention and deletion terms**: how long payloads, transcripts, vectors
   and logs are kept, how deletion is requested, and how it is confirmed.
3. **No training on customer content** (or explicit, separately-reviewed
   consent if any form of it is proposed).
4. **Sub-processor list and data residency** commitments.
5. **Incident/breach notification** commitments and timeline.
6. **A secure credential-custody model** that is compatible with the recorded
   non-transferable-key terms — pooled deployer keys for other users are
   prohibited by those terms; bringing a key is a design proposal, not proof
   that custody is allowed, and BYOK does not resolve the custody question
   (`docs/nan-provider-policy.md`).
7. **An auditable answer to the unknowns above**, or an explicit product
   decision to accept a named residual risk, recorded as an ADR.

Until then: synthetic fixtures and mocked providers only in CI, no live
provider calls in ordinary tests, no paid provisioning, and no production
multiuser traffic through one person's key.
