# NaN provider adapter and deployment gate (S11)

Checked 2026-10-02 against [NaN API examples](https://nan.builders/docs/examples), [model documentation](https://nan.builders/docs/models), and [terms](https://nan.builders/terms).

## Placement and boundary

`packages/worker/src/nan/` contains server-side HTTP adapters because ADR-0003 assigns provider/inference work to the worker/action boundary. `packages/shared` contains only runtime-neutral capability and policy contracts; neither package exposes `NAN_API_KEY` to `packages/app`.

The fixed base URL is `https://api.nan.builders/v1`. The adapter maps every documented product AI stage to NaN: `deepseek-v4-flash` chat for tutor and explicit text translation (including SSE streaming), `qwen3-embedding` (validated at 4096 dimensions), the separate nonstandard `/rerank` endpoint, Whisper transcriptions and audio-to-English translations, and Kokoro MP3 speech. Explicit defaults are `af_heart` (English) / `ef_dora` (Spanish), languages `en` and `es`, a 15 second timeout, 500 output tokens, 24,000 input characters, 25 MiB audio input, and zero automatic retries; callers decide whether and when to retry a typed `Retry-After` error. S16 keeps that voice/language pair as a visible configuration contract (`packages/worker/src/nan/speech.ts`): only the configured voices are synthesizable, an unknown voice or language is a typed refusal with the supported lists, and no STT language is claimed to have a TTS voice.

No adapter chooses a fallback provider. Unsupported configured models return `NAN_UNSUPPORTED_MODEL`; unsupported capabilities/voices return `NAN_UNSUPPORTED_CAPABILITY`; malformed provider payloads, timeout, cancellation, quota input limits and rate limits have distinct typed errors. The rerank endpoint is intentionally raw HTTP and separate from OpenAI-compatible client methods.

## Credential custody gate

NaN API keys are personal and non-transferable under the recorded terms. The only permitted initial deployment is self-hosted, single-user, with the deployer's server-side key serving that same deployer; code rejects hosted-multiuser use and prevents a deployer key from being used for another learner. A hosted multiuser product remains blocked pending a vendor-approved provider agreement and secure credential-custody model; BYOK is not treated as resolving custody or terms.

Keys are supplied only through server runtime configuration, never returned, logged, or committed. Diagnostic helpers redact authorization headers and key-shaped values. Do not log request bodies, because they can contain private learning content.

## Offline contracts and optional smoke

`pnpm test` uses injected mocked `fetch` functions and synthetic audio/JSON fixtures only; it makes zero network calls. Contract tests cover route/model choices, timeout, cancellation, HTTP 429 + `Retry-After`, configured-model rejection, malformed JSON/data and the policy gate.

An opt-in live smoke is deliberately not part of CI: source `NAN_API_KEY` into a transient shell from the coordinator-managed `/Users/andressantos/orca/workspaces/learn-anything/periwinkle/.env`, then invoke at most three tiny calls (one chat, one embedding and one speech) through a throwaway server-only script. Never echo the environment, write the key into this repository, or commit a result containing it. Record date, endpoint, status and redacted failure class in the PR; this change did not run live smoke calls.

## Operational limits and rollback

The known/unknown split for payloads, retention and the agreements required before hosted deployment lives in `docs/provider-data-handling.md` (S24; documentation only — no provider contact was made for it).

No live provider call is retried automatically; rate limits surface `retryAfterMs` (and, since S24, the standard `Retry-After` header), and quota exhaustion/unsupported models remain visible. Rollback is a code rollback that removes the adapter from server routing; it must not substitute another provider, pool a key, or bypass the single-user policy gate. S12 separately validates Convex's actual 4096-dimension index compatibility before embeddings are persisted.
