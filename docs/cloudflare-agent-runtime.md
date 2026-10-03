# Cloudflare agent runtime (S07)

Status: accepted for issue #11. Sources checked 2026-10-02; recheck versions,
limits and terms at every deployment.

`packages/agent` hosts learner agents with the Cloudflare Agents SDK on
Workers Free. It is an agent runtime only: no general frontend hosting, no
Cloudflare Access gate, no Workers AI inference, no paid plan and no
automatic upgrade. Convex stays the durable store for projects, documents and
messages; the Durable Object holds only short-lived, scoped session state.

## Pinned versions

| Component | Pin | Notes |
| --- | --- | --- |
| `agents` (Agents SDK) | 0.26.0 | Exact dependency pin in `packages/agent/package.json` |
| `wrangler` | 4.147.0 | Exact devDependency; also the CLI used by `pnpm build` (`wrangler deploy --dry-run`) |
| Workers runtime | workerd 1.20261001.1 | Bundled by wrangler 4.147.0; the local test runtime comes from `@cloudflare/vitest-plugin` |
| `compatibility_date` | 2026-08-01 | Pinned in `packages/agent/wrangler.json` with `nodejs_compat` (required by the Agents SDK) |
| `@cloudflare/workers-types` | 5.20261002.1 | Exact devDependency |
| `@cloudflare/vitest-plugin` | 1.3.6 | Exact devDependency; runs the runtime test suite inside workerd |
| `msw` / `@msw/cloudflare` | 3.0.1 / 0.2.0 | Exact devDependencies; outbound mocking for the runtime suite |
| `vitest` | 4.1.11 | Workspace root and runtime suite runner |
| Node (CI) | 22.14.0 | Quality gates workflow |
| pnpm | 10.20.0 | Repository `packageManager` |

An SDK or runtime upgrade is a deliberate change: update the pin, the
`compatibility_date` and this table together, then rerun the full test suite.

## Official Workers Free and Durable Objects Free limits (checked 2026-10-02)

Sources: [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
(last updated Sep 5, 2026) and
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
(last updated Sep 30, 2026).

Workers Free:

| Limit | Value | Behaviour when exceeded |
| --- | --- | --- |
| Requests | 100,000/day (resets 00:00 UTC) | Error 1027; requests fail |
| CPU time per HTTP request | 10 ms | Error 1102 (`Worker exceeded resource limits`) |
| Memory per isolate | 128 MB | Error 1102 |
| Subrequests per request | 50 (6 simultaneous while waiting for headers) | Request fails |
| Environment variables | 64 per Worker, 5 KB each | Deployment rejects more |
| Worker size / startup | 64 MiB / 1 second | Deployment rejected |
| Workers per account / cron triggers | 100 / 5 | Deployment rejected |
| HTTP duration | No hard limit while the client stays connected | — |
| Request body | 100 MB (Free account plan) | 413 |

Durable Objects Free (SQLite backend only; key-value backend is unavailable
on Free):

| Limit | Value | Behaviour when exceeded |
| --- | --- | --- |
| Requests | 100,000/day | Operations of that type fail with an error |
| Duration | 13,000 GB-s/day | Operations of that type fail with an error |
| SQLite row reads | 5,000,000/day | Operations of that type fail with an error |
| SQLite row writes | 100,000/day (deletes count as writes) | Operations of that type fail with an error |
| SQL stored data | 5 GB total | Operations of that type fail with an error |

Daily free limits reset at 00:00 UTC. Cloudflare documents that exceeding
any one free-tier limit makes further operations **of that type fail with an
error** — the S07 runtime maps those failures to a visible
`AGENT_QUOTA_EXCEEDED` message (HTTP 507 on HTTP routes, an `error` frame on
WebSocket routes) that states the Free-plan quota was reached and that this
deployment **never upgrades to a paid plan automatically**. There is no
paid-plan fallback, no provider substitution and no retry-with-upgrade path
in the code.

Configuration review recorded for this repository: `wrangler.json` contains
no `ai` binding (Workers AI is unused), no `routes`, `zone_id` or `assets`
(no general frontend hosting), no `account_id` and no `plan` field (nothing
selects a paid plan). A test (`packages/agent/tests/config.test.ts`) enforces
this review on every run.

## Identity handshake (consumes the S06 contract)

Cloudflare does not accept Convex Auth JWTs implicitly, and browser sessions
are never handed to the agent runtime. The bridge uses the S06 short-lived,
server-issued connection token (ADR-0004):

1. The authenticated owner calls Convex `issueConnectionToken` (S06) and
   receives a 256-bit token bound to `ownerId + projectId`, TTL 300 s
   (max 900 s). The call only succeeds for a full Convex Auth session subject
   (`userId|sessionId`): an identity carrying only an email address or only a
   user id is rejected, so the stored binding can never be email-only or
   user-id-only.
2. `POST /agent/session { token, reconnect? }` on the agent Worker verifies
   the token against the Convex deployment
   (`/agent/connection-tokens/verify`, or `/reconnect` which rotates the
   token so the presented one becomes a rejected replay) and returns the
   owner-scoped `instanceId` plus `connectPath`.
3. The client opens `connectPath?token=...`. Before any Durable Object is
   created or reached, `onBeforeConnect` (WebSocket) or `onBeforeRequest`
   (HTTP) re-verifies the token against Convex, checks that
   `HMAC(AGENT_BRIDGE_SECRET, ownerId + projectId)` equals the requested
   instance name, strips every client-supplied bridge/authorization header
   and forwards a signed, short-lived `x-agent-session` header.
4. `onConnect` parses the signed header, re-derives the scope, verifies the
   token against Convex again and only then registers the session (SQLite
   row). Failure closes the socket with a typed code.
5. Every WebSocket message and HTTP request re-verifies the presented token
   against Convex **before** any state read or provider call, then updates
   `last_verified_at`. Revocation, rotation, expiry and scope violations
   therefore stop the very next operation with a visible typed error
   (`CONNECTION_TOKEN_*`, `AGENT_SESSION_*`, `AGENT_SCOPE_MISMATCH`).

No shared server secret ever replaces an owner check: the HMAC only binds
instance addressing; Convex remains the authority for identity, ownership and
project liveness on every operation.

## Agent instance ids

`instanceId = "la_" + HMAC-SHA256(AGENT_BRIDGE_SECRET, ownerId + "\n" + projectId)[0..32]`
(128 bits of a keyed hash). The id is unguessable without the deployment
secret, deterministic across reconnects (the same owner+project always
reaches the same Durable Object), and never embeds the owner id, project id,
conversation id or any other readable identifier. Two-user isolation tests
assert that user two's valid token is refused (403 `AGENT_SCOPE_MISMATCH`) on
user one's instance and that derived ids differ per owner and per project.

## Durable Object state (SQLite, scoped)

The class is declared with the declarative `exports` field
(`"storage": "sqlite"`), which is the only backend available on Workers Free.
Its own state is two small tables created in `onStart`:

- `agent_scope(instance_id, owner_id, project_id, created_at)` — one row per
  instance, the scope binding.
- `agent_connection_session(connection_id, token, owner_id, project_id,
  last_verified_at, expires_at)` — one row per open WebSocket, holding the
  connection credential only for the lifetime of the session (TTL ≤ 900 s),
  deleted on close and swept when expired.

The Agents SDK additionally persists its own internal tables
(`cf_agents_state` and friends); this runtime does not use JSON state.
Nothing durable lives here: projects, documents, messages, transcripts,
progress and provider results remain in Convex, which the browser reads
through authorized Convex functions. Logs never contain tokens.

## NaN provider path (no Workers AI)

LLM, speech, embeddings and rerank go through the S11 `NanClient` adapters
from `packages/worker` via `createNanBridge` (`packages/agent/src/nanBridge.ts`):
fixed NaN base URL, pinned model ids, input caps and the personal-key
deployment policy (single-user self-hosted only; a learner who is not the
configured `NAN_DEPLOYER_ID` receives a visible `NAN_POLICY_BLOCKED` error).
There is no `ai` binding, no `env.AI` usage and no fallback provider anywhere
in the package, enforced by `tests/config.test.ts`.

## Configuration and secrets

| Name | Where | Committed value |
| --- | --- | --- |
| `CONVEX_URL` | `wrangler.json` `vars` | empty string (deployment coordinate, set per environment) |
| `NAN_DEPLOYER_ID` | `wrangler.json` `vars` | empty string (owner id of the single-user deployer) |
| `AGENT_BRIDGE_SECRET` | `wrangler secret put` / `.dev.vars` | never committed (`.dev.vars.example` holds an empty template) |
| `NAN_API_KEY` | `wrangler secret put` / `.dev.vars` | never committed (root `.env.example` also documents it) |

With `AGENT_BRIDGE_SECRET` unset the runtime refuses connections with a
visible `AGENT_NOT_CONFIGURED` error; with `NAN_API_KEY` unset the adapter
refuses calls with `NAN_PROVIDER_ERROR`.

## Commands

```sh
pnpm --filter @learn-anything/agent typecheck   # tsc over src + tests (workers types)
pnpm lint
pnpm test                                       # Node suite + runtime suite (chained)
pnpm --filter @learn-anything/agent test:runtime  # runtime suite alone (workerd)
pnpm --filter @learn-anything/agent build       # wrangler deploy --dry-run (bundling smoke)
```

The runtime suite (`tests/runtime/`) is the local SDK smoke test: real
Agents SDK, real Worker, real SQLite-backed Durable Object inside workerd,
with Convex and NaN calls mocked by MSW — no live secrets, no network, no
provider quota.

## Deployment, migration and rollback

The full operator procedure (environments, secret storage per environment,
health-check gate, backup/restore and recovery) is
`docs/deployment-runbook.md` (S25).

- No Convex schema/function change ships with S07; the runtime only consumes
  the S06 HTTP routes. Convex rollback is independent of this package.
- First deploy creates the `LearnerAgent` Durable Object namespace with the
  SQLite backend (declarative `exports`). Durable Object rows are transient
  session state; no backfill or data migration is required.
- Rollback: `npx wrangler rollback` redeploys the previous Worker version.
  Never delete the `LearnerAgent` export (deleting would tombstone the
  namespace); to retire the runtime, remove the Worker but keep the class
  export until Cloudflare's documented deletion procedure is deliberately
  executed.
- Quota exhaustion during operation is a visible error, never a plan change.
  Recovery is waiting for the daily reset (00:00 UTC) or reducing usage.

## Known limits

- Per-operation Convex verification adds one Convex function call per agent
  message/request; Convex Free includes 1 million function calls/month.
- One connection token ties a session to a TTL ≤ 900 s; long conversations
  re-handshake through the reconnect rotation (later stories wire the client
  loop).
- The single-user NaN gate intentionally blocks every learner except
  `NAN_DEPLOYER_ID`; hosted multiuser use stays blocked (README deployment
  gate).
- Workers Free CPU is 10 ms per HTTP request; heavy parsing or embedding
  orchestration belongs in Convex actions (ADR-0002), not here.
