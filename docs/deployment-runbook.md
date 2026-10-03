# Agent-only deployment and recovery runbook (S25)

Status: accepted for issue #29. **Documentation only** — no cloud account was
provisioned, no secret was inserted, no production was activated and no
provider was contacted for this story. Sources checked 2026-10-03 against
`main` @ `f872af6` (S24 observability merged) with the pinned toolchain
(`pnpm@10.20.0`, `convex@1.43.0`, `wrangler@4.147.0`); recheck versions,
quotas, plan names and dashboard surfaces at every authorized deployment.

Companion documents (the delivery contract this runbook consumes):
`docs/cloudflare-agent-runtime.md` (S07 limits and handshake),
`docs/convex-development.md` (S03–S24 schema, migrations, quotas),
`docs/adr/0002-runtimes-and-deployment-boundary.md`,
`docs/adr/0003-package-layout-and-versioned-configuration.md`,
`docs/adr/0004-authentication-method.md`,
`docs/provider-data-handling.md` and `docs/nan-provider-policy.md`.

## 0. What this runbook is (and is not)

It is the operator procedure for deploying and recovering the v0.1 system in
three environments (dev, staging, production) on **Cloudflare Workers Free +
Convex Free**, for a **restricted single-user** deployment.

It is **not** authority to provision anything. It does not create accounts,
deployments, Workers, secrets, DNS, payment methods or paid resources; every
command that touches a live deployment is marked *(live)* and runs only when a
separate, explicit authorization exists. Commands marked *(offline)* run with
no credentials and synthetic/fake values only, and never authenticate against
or write to a deployment: `wrangler deploy --dry-run` reads and validates the
committed `wrangler.json`, bundles with the installed toolchain, prints the
binding table and exits before anything is uploaded — no upload, no asset
sync, no Durable-Object migration lookup. With no account id in play (this
repository's `wrangler.json` carries no `account_id`, and the offline block
does not set `CLOUDFLARE_ACCOUNT_ID`) it also makes no Cloudflare API call at
all; if an account id *is* configured, wrangler first reads the current
deployment's versions from the Cloudflare API, which needs credentials. These
commands are **not** guaranteed to be network-free: wrangler still posts its
anonymous usage metrics to `sparrow.cloudflare.com` unless telemetry is
disabled, so set `WRANGLER_SEND_METRICS=false` (or run
`wrangler telemetry disable`) before an offline rehearsal on a machine that
must send nothing at all.

## 1. Deployment boundary: Cloudflare hosts agents only

Stated plainly, because it is the boundary everything else depends on
(`docs/adr/0002`, `docs/cloudflare-agent-runtime.md`, ADR-0001):

| Surface | Where it runs | What it never does |
| --- | --- | --- |
| Web client (React/Vite SPA) | **Vercel** (Hobby/free tier): the static build of `packages/app`, contract in the repository-root `vercel.json` (ADR-0002 amended by issue #38) | Never holds `NAN_API_KEY`, `AGENT_BRIDGE_SECRET`, `JWT_PRIVATE_KEY`, `CONVEX_DEPLOYMENT` or any `*_SECRET`; no server code runs there |
| Durable data, auth, ingestion, HTTP actions | **Convex** (Free plan deployment) | Never auto-upgrades to a paid plan |
| Learner agents (Agents SDK + SQLite Durable Objects) | **Cloudflare Workers Free** (`packages/agent`) | No frontend hosting, no Cloudflare Access gate, no Workers AI, no routes/custom domains, no paid plan |
| Provider calls (NaN) | Server-side only: Convex actions/HTTP routes **and** the agent Worker | Never from the browser, never pooled across users |

- **No Cloudflare Access gate.** Identity authority is Convex Auth only
  (`docs/adr/0004`). Cloudflare adds no authentication layer in front of
  anything; the agent Worker enforces the Convex-issued connection token
  itself (Section 5.5).
- **No frontend hosting on Cloudflare.** `packages/agent/wrangler.json`
  contains no `assets`, `routes`, `zone_id` or `workers_dev` key, and
  `packages/agent/tests/config.test.ts` fails CI if any appears. Frontend
  hosting is Vercel — web client only, `vercel.json` in the repository root
  (ADR-0002 as amended by issue #38; ADR-0001 records the framework choice,
  not the host).
- **Agent-only Worker.** The Worker serves exactly two path families:
  `POST /agent/session` and `/agent/learner-agent/:instanceId`
  (`packages/agent/src/routes.ts`). Everything else returns
  `AGENT_NOT_FOUND`.

## 2. Environments: dev, staging, production

### 2.1 Environment matrix

Three environments, fully separated: distinct Convex deployment, distinct
Worker, distinct frontend origin, distinct variable values. Values are never
copied between environments; each environment is set explicitly
(`docs/convex-development.md`, "Deployment and secrets boundary").

| Piece | dev | staging | prod |
| --- | --- | --- | --- |
| Convex deployment | `npx convex dev` development deployment (reference `dev`) | its own deployment, e.g. `npx convex deployment create staging --type prod` *(live)*, then `npx convex deployment select staging` *(live)* | the project's default production deployment |
| Convex code push | `npx convex dev` (watch) | `npx convex deploy` with the staging deployment selected (or a `CONVEX_DEPLOY_KEY` issued for it) *(live)* | `npx convex deploy` — the CLI targets the default production deployment when `CONVEX_DEPLOYMENT` is set, or the deployment named by `CONVEX_DEPLOY_KEY` *(live)* |
| Convex variables | `npx convex env set <NAME> <value>` (dev), or `packages/api/.env.local` for the CLI coordinate | `npx convex env set --deployment staging <NAME> <value>` | `npx convex env set --prod <NAME> <value>` |
| Agent Worker | `pnpm --filter @learn-anything/agent dev` (`wrangler dev`) with `packages/agent/.dev.vars` | a staging Worker (separate name or separate account) deployed with `npx wrangler deploy` *(live)* | the production Worker `learn-anything-agent`, `npx wrangler deploy` *(live)* |
| Worker variables/secrets | `.dev.vars` (gitignored) | `npx wrangler secret put <NAME>` + `--var`/config per environment *(live)* | same, on the production Worker *(live)* |
| Frontend origin | `http://localhost:5173` (Vite dev) | a Vercel preview origin for that branch, e.g. `https://app-<deployment-id>-<team>.vercel.app` (per-deployment URLs are Vercel-auth-protected) | `https://app-dun-seven-88.vercel.app` (the production alias recorded in issue #38) |
| Frontend build | `VITE_CONVEX_URL` / `VITE_CONVEX_SITE_URL` baked per environment at build time | same, staging/preview values (Vercel project environment variables, read by `buildCommand`) | same, production values |
| Provider key | dev key or empty (offline tests never need it) | staging key (same deployer) | deployer's key, server-side only |
| Plan | Convex Free, Cloudflare Workers Free | Convex Free, Cloudflare Workers Free | Convex Free, Cloudflare Workers Free |

Rules:

1. One environment's `CONVEX_URL` must never be configured into another
   environment's Worker (`packages/agent/wrangler.json` commits an empty
   `CONVEX_URL`; it is injected per environment).
2. `VITE_CONVEX_URL` is public **by design** — it is baked into the client
   bundle. It is a deployment coordinate, never a credential, and it must be
   built per environment (a staging bundle pointing at prod is a release
   defect).
3. Staging exists so that migration, health-check and rollback drills
   (Sections 6–9) can be exercised before production.
4. Deployment references (`dev`, `staging`, `prod`, deployment names) are
   verified per project at provisioning time with a command that actually
   resolves them: `npx convex env list --deployment <ref>` *(live)* lists
   that deployment's environment variables when `<ref>` exists and errors
   instead of listing when it does not (the Convex dashboard's Deployments
   page shows the same). A bare `npx convex deployment` only prints the
   subcommand usage (`select`, `create`, `token`, `usage`, `usage-limits`)
   and confirms nothing about the project. This runbook does not assume
   which references already exist.
5. `convex deploy` has **no** `--prod`/`--deployment` flag (verified on the
   pinned CLI): the target comes from `CONVEX_DEPLOYMENT` /
   `CONVEX_DEPLOY_KEY` / the selected deployment. Always confirm the target
   with `npx convex deploy --dry-run` *(live)* before a real push. By
   contrast `convex run`, `convex env`, `convex export` and
   `convex deployment usage*` do accept `--prod` / `--deployment`.

### 2.2 Convex Auth provider callback allowlists per environment

Convex Auth is the only identity layer (`docs/adr/0004`). The allowlist is
**exact-match, fail-closed, per environment**
(`packages/api/convex/redirects.ts`): `redirectTo` is accepted only when it
exactly equals `SITE_URL` or an entry of `AUTH_REDIRECT_URIS`; wildcards,
other origins and unconfigured paths are rejected with `REDIRECT_NOT_ALLOWED`.
With no configuration at all, every redirect is rejected.

Set these on **each** deployment independently:

| Variable | Per-environment value | Set with *(live)* |
| --- | --- | --- |
| `SITE_URL` | The exact origin of that environment's frontend (`http://localhost:5173`, `https://staging.<example>`, `https://<example>`) | `npx convex env set SITE_URL <origin>` (`--deployment staging` / `--prod`) |
| `AUTH_REDIRECT_URIS` | Comma-separated exact redirect URIs of that environment only, e.g. `https://staging.<example>/#/`,`https://staging.<example>/#/auth/callback` | `npx convex env set AUTH_REDIRECT_URIS <uris>` |
| `JWT_PRIVATE_KEY`, `JWKS` | Generated **per deployment**; never shared between environments | `npx convex env set` with the generated pair (never committed) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Both values of a provider must exist on that deployment or the provider is not registered at all | `npx convex env set` |

Additional rules:

- **OAuth app callback registration.** Each Convex deployment has its own
  `${CONVEX_SITE_URL}`; the provider app must allow
  `${CONVEX_SITE_URL}/api/auth/callback/github` (or `google`) for **each**
  environment deployment that uses OAuth. Prefer one OAuth app per
  environment when the provider allows it, so a staging credential cannot act
  on production. Registering an OAuth app is an external provisioning action
  and is out of scope for this issue (ADR-0004).
- **CORS allowlist follows the same two variables.** The S15/S18/S16 HTTP
  routes build their allowed origins only from the origin of `SITE_URL` plus
  the origins of `AUTH_REDIRECT_URIS` (`packages/api/convex/cors.ts`), never a
  wildcard — so a staging origin that is missing from the staging allowlist
  is not echoed back, and a staging origin must never be added to the
  production allowlist.
- **Vercel origins are exact entries, never wildcards (issue #38).** The
  production origin `https://app-dun-seven-88.vercel.app` is `SITE_URL` on the
  production Convex deployment, with
  `https://app-dun-seven-88.vercel.app/#/` and
  `https://app-dun-seven-88.vercel.app/#/auth/callback` appended to
  `AUTH_REDIRECT_URIS`. Per-deployment preview URLs are Vercel-auth-protected
  and are added **one exact origin at a time** to a preview/staging
  deployment's allowlist when manual testing needs them; a pattern such as
  `https://app-*.vercel.app` is rejected — the allowlist is exact-match and
  fail-closed (see section 13.5 for the full entry table).
- **Password-only until an email/OAuth provider exists.** No email provider
  is registered, so OTP, magic link, verification and password reset are
  unavailable rather than half-configured (ADR-0004). Production sign-in
  quality (recovery) is a documented gap, not an accident.
- **Verification *(live)*:**

  ```sh
  npx convex env list --names-only            # dev
  npx convex env list --names-only --prod     # prod
  npx convex env list --names-only --deployment staging
  ```

  Expect the names above on every deployment, with per-environment values
  (compare `SITE_URL` values with `npx convex env get SITE_URL`).

## 3. Secrets: where every key lives, and how to prove nothing leaked

### 3.1 Storage classes

| Class | Storage | Allowed in |
| --- | --- | --- |
| **Secret** | Cloudflare Worker secret (`npx wrangler secret put <NAME>` *(live)*, local `packages/agent/.dev.vars`), Convex deployment variable (`npx convex env set <NAME>` *(live)*, local `packages/api/.env.local`), CI secret store | Server-side only |
| **Server-side non-secret config** | Convex deployment variable or Worker `vars` (`--var` / `wrangler.json`) | Server-side only (not sensitive, but not for the browser) |
| **Public build-time config** | `VITE_*` values | Client bundle — by design, must be non-secret |
| **Operator/CI credentials** | Local gitignored `.env`, or the CI secret store | Never on a Worker, never in a repo, never in a build |

Committed examples (`.env.example`, `packages/api/.env.example`,
`packages/agent/.dev.vars.example`) are **empty templates only**; this is
enforced by `packages/app/tests/no-provider-secrets.test.ts` (every
non-comment line must match `^[A-Z0-9_]+=$`) and
`packages/agent/tests/config.test.ts` (the `.dev.vars.example` values must be
empty). `.gitignore` excludes `.env`, `.env.*` (except `.env.example`) and
`.dev.vars*` (except `.dev.vars.example`).

### 3.2 Key-by-key map (every entry of the committed examples)

`Y` = must be set for that environment, `-` = not present there.

| Key (from `.env.example` and friends) | Class | dev | staging | prod | Consumed by |
| --- | --- | --- | --- | --- | --- |
| `NAN_API_KEY` | secret | Y¹ | Y | Y | Convex deployment var (S15/S18/S16/S14 routes and actions) **and** Cloudflare Worker secret (agent `nanBridge`) |
| `NAN_DEPLOYER_ID` | server config | Y | Y | Y | Convex deployment var **and** Worker `vars`; the single-user policy gate (S11) |
| `CONVEX_URL` | server config | Y² | Y | Y | Worker `vars`; the agent's Convex verification base URL |
| `CONVEX_DEPLOYMENT` | operator local | Y | - | - | Local CLI coordinate in `packages/api/.env.local` (dev only) |
| `AGENT_BRIDGE_SECRET` | secret | Y³ | Y | Y | Cloudflare Worker secret (`wrangler secret put`); HMAC for agent instance ids |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | operator/CI secret | optional | optional | optional | Only the machine running `wrangler` (local `.env` or CI secret). Never a Worker binding, never client |
| `CONVEX_DEPLOY_KEY` (CI-only, not in the example) | operator/CI secret | - | optional | optional | Only if a deploy job is ever added to CI; the current Quality gates workflow does not deploy |
| `SITE_URL`, `AUTH_REDIRECT_URIS` | server config (allowlist) | Y | Y | Y | Convex deployment vars (Section 2.2) |
| `JWT_PRIVATE_KEY`, `JWKS` | secret | Y | Y | Y | Convex deployment vars, generated per deployment (ADR-0004) |
| `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` | secret | optional | optional | optional | Convex deployment vars; both of a pair or neither |
| `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` | **public** | Y | Y | Y | Baked into `packages/app` bundle per environment |
| `STT_TIMEOUT_MS`, `TTS_TIMEOUT_MS` | server tuning | optional | optional | optional | Convex deployment vars (defaults 15000 ms) |
| `MAX_UPLOAD_BYTES` | server tuning | optional | optional | optional | Convex deployment var; empty → 10 MiB cap, never above `10485760` |
| `INGESTION_MAX_ATTEMPTS`, `INGESTION_BACKOFF_BASE_MS`, `INGESTION_LEASE_MS`, `INGESTION_PARSE_TIMEOUT_MS`, `INGESTION_CHUNK_SIZE`, `INGESTION_CHUNK_OVERLAP` | server tuning | optional | optional | optional | Convex deployment vars; clamped, never trusted |
| `RATE_LIMIT_REQUESTS`, `RATE_LIMIT_WINDOW_SECONDS`, `MAX_AUDIO_DURATION_SECONDS`, `MAX_CONCURRENT_TURNS`, `LOG_RETENTION_DAYS` | server tuning | optional | optional | optional | Convex deployment vars (S24); empty → defaults |
| `packages/agent/.dev.vars.example`: `AGENT_BRIDGE_SECRET`, `NAN_API_KEY` | secret (local dev) | Y³ | - | - | Local `wrangler dev` only; production uses `wrangler secret put` |

¹ Dev may leave the provider key empty: every provider route then fails
visibly (`STT_NOT_CONFIGURED`, `TTS_NOT_CONFIGURED`, `TURN_NOT_CONFIGURED`,
`NAN_PROVIDER_ERROR`) instead of silently degrading.
² The committed `wrangler.json` value is `""`; the real value is injected per
environment.
³ With `AGENT_BRIDGE_SECRET` unset the Worker refuses every connection with a
visible `AGENT_NOT_CONFIGURED` (HTTP 503).

Where each class is written per environment:

```sh
# secrets and server config on Convex (live)
npx convex env set NAN_API_KEY '<value>'            # dev deployment
npx convex env set --prod NAN_API_KEY '<value>'     # production
npx convex env set --deployment staging NAN_API_KEY '<value>'

# secrets on the agent Worker (live)
npx wrangler secret put NAN_API_KEY                 # prompts, never echoes
npx wrangler secret put AGENT_BRIDGE_SECRET

# local-only, gitignored
#   .env / packages/api/.env.local        -> Convex CLI + app build values
#   packages/agent/.dev.vars              -> wrangler dev
```

### 3.3 Proof that no secret reached a client asset

Run after every frontend build (offline; the build below uses **fake**
coordinates on purpose):

```sh
VITE_CONVEX_URL=https://fake-0000.convex.cloud \
VITE_CONVEX_SITE_URL=https://fake-0000.convex.site \
pnpm --filter @learn-anything/app build

if grep -rEn 'NAN_API_KEY|NAN_DEPLOYER_ID|AGENT_BRIDGE_SECRET|JWT_PRIVATE_KEY|GITHUB_CLIENT_SECRET|GOOGLE_CLIENT_SECRET|CONVEX_DEPLOYMENT|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|AUTH_REDIRECT_URIS|INGESTION_|RATE_LIMIT_|LOG_RETENTION' packages/app/dist; then
  echo 'FAIL: server/secret name in client bundle'; exit 1
fi
grep -rEn 'https://fake-0000\.convex\.(cloud|site)' packages/app/dist >/dev/null \
  || { echo 'FAIL: expected fake public coordinate missing'; exit 1; }
echo 'OK: client bundle carries no server/secret configuration, only the intended public VITE_* coordinate'
```

Plus the standing checks: `pnpm test` (which pins the empty examples and the
forbidden-name list in `packages/app/src`), `git ls-files` showing no env
file other than the `*.example` templates, and the repository Gitleaks
`Secret scan` job on every PR (`docs/ci-quality-gates.md`).

For the Worker bundle the equivalent proof is the dry-run binding table
(Section 7): the committed config contributes only `env.CONVEX_URL ("")` and
`env.NAN_DEPLOYER_ID ("")`, secrets are read from the platform's secret store
at runtime, and `config.test.ts` asserts that `AGENT_BRIDGE_SECRET` and
`NAN_API_KEY` never appear in `wrangler.json`.

## 4. Plans, quotas and the no-billing guard

### 4.1 Convex Free is not the metered Starter plan

| | **Convex Free (the selected plan)** | Metered Starter (not selected) |
| --- | --- | --- |
| What it is | A quota-bounded free tier | A paid, usage-metered plan |
| Selected here? | **Yes** — `docs/convex-development.md` "Plan and operational limits" | **No** |
| On quota exhaustion | Requests fail visibly; the plan does not change | Usage is billed |
| Who may change it | The account owner, as an explicit, separately reviewed decision | — |

Recorded Free quotas (checked 2026-10-02/03; **re-verify at deployment**):
**0.5 GB database, 1 GB/month database I/O, 1 GB file storage, 1 GB/month
data egress, 0.5 GB search storage, 3,000 query-GB/month search queries,
1 million function calls/month.** Each vector search bills the whole index
size in query-GB regardless of filters (`docs/convex-development.md`, S12).

### 4.2 Backend usage alerts (verify and configure per environment)

The pinned Convex CLI exposes usage and usage limits directly (verified by
`npx convex deployment usage --help`, `npx convex deployment usage-limits
set --help` and `npx convex deployment usage-limits --help`, offline):

```sh
# current usage for every metric, this day and this calendar month (live)
npx convex deployment usage --json
npx convex deployment usage --prod --json

# configured limits: --type warning only notifies; --type disable pauses the
# deployment when exceeded (both verified CLI choices; neither spends money)
npx convex deployment usage-limits list --prod
npx convex deployment usage-limits set --metric functionCalls --window month --type warning --limit 900000
```

A usage limit either **warns** (`--type warning`, notifies only) or **pauses**
(`--type disable`) the deployment when a metric crosses a threshold inside a
`day` or `month` window — it never buys anything. The CLI's limitable metrics
are exactly: `functionCalls`, `databaseIoGb`, `searchQueryGb`, `dataEgressGb`
and the compute gb-hours metrics (`queryMutationComputeGbHours`,
`actionComputeConvexGbHours`, `actionComputeNodeJsGbHours`,
`actionComputeCpuGbHours`). Mapped to the Free quotas in Section 4.1:

| Free quota | Limit metric | Coverage |
| --- | --- | --- |
| 1 million function calls/month | `functionCalls` | limit configurable |
| 1 GB/month database I/O | `databaseIoGb` | limit configurable |
| 3,000 query-GB/month search | `searchQueryGb` | limit configurable |
| 1 GB/month data egress | `dataEgressGb` | limit configurable |
| 0.5 GB database, 1 GB file storage, 0.5 GB search storage | **no limit metric in the CLI list** | watch only: `npx convex deployment usage --json` and the dashboard storage meters |

The operator procedure per environment:

1. Read `npx convex deployment usage --json` and compare each metric with the
   Free quotas above.
2. Configure `warning` limits at a sensible fraction of each limitable quota
   (example above: 900,000 of 1,000,000 monthly function calls; repeat for
   `databaseIoGb`, `searchQueryGb`, `dataEgressGb`). Use `disable` only
   deliberately: it pauses the deployment rather than degrading it.
   Storage quotas (no limit metric) are covered by step 1 and step 3.
3. Also enable the dashboard's own notifications if the plan offers them —
   **verify that surface in the dashboard at provisioning time and record the
   result**; this runbook deliberately does not assume a specific alert
   product feature that was not checked.
4. Fallback that needs no dashboard feature: an operator-owned monthly check
   of `npx convex deployment usage --json` per environment.

### 4.3 What happens when a Convex quota is hit, and how to recover

- **What happens:** queries/mutations/actions fail with visible platform
  errors. Nothing auto-upgrades: Convex plan changes are dashboard/account
  actions, and no code or workflow in this repository performs one.
- **Recovery path (in order):**
  1. Confirm the hit: `npx convex deployment usage --json` shows the metric
     at/over its limit.
  2. Reduce usage: stop non-essential ingestion (the 5-minute
     `ingestion-cycle` cron is bounded and can be left idle), delete data the
     learner no longer needs (S04/S08/S22/S24 deletion flows are bounded and
     idempotent), tighten `LOG_RETENTION_DAYS` / rate limits, and recheck
     vector-search index size (search storage and query-GB are the most
     expensive metrics per byte).
  3. Wait for the window to reset (daily metrics reset daily; monthly metrics
     reset with the calendar month) and re-run the health gate.
  4. If usage is genuinely permanent, that is a **billing decision** for the
     account owner in a separate, reviewed issue — never an automatic step.
- **The guard:** quota exhaustion must NOT trigger a billing upgrade.
  Concretely: (a) neither platform upgrades a plan by itself; (b) no code,
  script or CI job in this repository changes a plan — the Quality gates
  workflow only lints, typechecks, tests, builds, scans secrets and audits
  dependencies (`docs/ci-quality-gates.md`); (c) `usage-limits` with
  `--type warning`/`disable` makes exhaustion visible or pauses service instead
  of spending; (d) any proposal to enable Starter is a separate reviewed
  issue, not a runbook step.

### 4.4 Cloudflare Workers Free and SQLite-backed Durable Objects (verified)

The authoritative table, with the behaviour-on-exceed column, lives in
`docs/cloudflare-agent-runtime.md` ("Official Workers Free and Durable
Objects Free limits", checked 2026-10-02) and is asserted marker-by-marker by
`packages/agent/tests/config.test.ts`. Summary:

- **Workers Free:** 100,000 requests/day (error 1027), 10 ms CPU per request
  and 128 MB memory per isolate (error 1102), 50 subrequests, 64 environment
  variables of 5 KB each, 64 MiB Worker size, 100 Workers per account.
- **Durable Objects Free, SQLite backend only** (the key-value backend is
  unavailable on Free): 100,000 requests/day, 13,000 GB-s/day, 5,000,000
  SQLite row reads/day, 100,000 row writes/day (deletes count as writes),
  5 GB SQL storage. Daily limits reset at **00:00 UTC**.
- **SQLite behaviour in this runtime:** the class is declared with the
  declarative `exports` field (`"storage": "sqlite"`), created on first
  deploy. It stores only `agent_scope` and `agent_connection_session` rows
  plus the Agents SDK's own tables; sessions are TTL-bound (≤ 900 s) and
  swept on close. Nothing durable lives in the Durable Object — Convex owns
  projects, documents, messages and progress — so losing or rolling back DO
  state loses no learning record.
- **Verified shape:** `npx wrangler deploy --dry-run` (Section 7) prints the
  binding table (`env.LearnerAgent (LearnerAgent) Durable Object`,
  `env.CONVEX_URL ("")`, `env.NAN_DEPLOYER_ID ("")`), and
  `packages/agent/tests/config.test.ts` fails CI if `plan`, `account_id`,
  `ai`, `assets`, `routes`, `zone_id`, `kv_namespaces`, `d1_databases`,
  `r2_buckets` or `queues` ever appears in `wrangler.json`, or if a secret
  name is moved into `vars`.

### 4.5 What happens when a Cloudflare quota is hit, and how to recover

- **What happens:** Cloudflare makes further operations **of that type fail
  with an error** (documented behaviour, quoted in
  `packages/agent/src/quota.ts`). The runtime converts those failures into
  one visible client error: `AGENT_QUOTA_EXCEEDED` (HTTP 507 on HTTP routes,
  an `error` frame on WebSocket routes) whose fixed message states that this
  deployment **never upgrades to a paid plan automatically** and that the
  operator must retry after the 00:00 UTC reset or reduce usage.
- **Recovery path:** wait for the daily reset, or reduce usage (fewer
  concurrent sessions, shorter conversations, fewer reconnects). Record the
  incident and the metric that tripped.
- **The guard:** there is no paid-plan fallback, no retry-with-upgrade and no
  provider substitution anywhere in the code (`packages/agent/src/quota.ts`),
  `wrangler.json` contains no `plan`/`account_id` so a deploy cannot select a
  paid plan, and Cloudflare does not move an account to a paid plan by
  itself. Enabling a paid plan would be a separate, explicit account action
  in a separate reviewed issue.

## 5. Convex schema and data migrations, retries, private storage, agent entry points

### 5.1 Versioned schema markers

- `packages/api/convex/version.ts`: `SCHEMA_VERSION = 12`,
  `FUNCTION_VERSION = 12`, `BOOTSTRAP_MIGRATION = "bootstrap-schema-v12"`.
- The `schemaMetadata` row records the applied marker;
  `internal.migrations.checkCompatibility` reports
  `{ compatible, foundSchemaVersion, expectedSchemaVersion,
  expectedFunctionVersion }`. A deployment whose marker does not match is
  **not** ready to serve the new release.
- There are **no SQL migrations**. Schema and functions are versioned and
  pushed together by the Convex CLI; data changes ship as versioned,
  resumable Convex migrations (`docs/adr/0003`).

### 5.2 Resumable migration / backfill rules (what any future migration must do)

The current marker, `internal.migrations.bootstrapSchemaV12`, is the model
(`packages/api/convex/migrations.ts`):

1. The first call records the run; each later call performs **one bounded
   batch** (100 rows, indexed order), stores a cursor, and the final call
   writes the version marker.
2. Batches are **idempotent**: an interrupted batch that replays changes
   nothing twice.
3. Run it until the result says `completed: true`:

   ```sh
   npx convex run internal.migrations.bootstrapSchemaV12 '{}'   # (live; add --prod or --deployment <ref> for that environment)
   ```

4. Verify:

   ```sh
   npx convex run internal.migrations.checkCompatibility '{}'
   ```

Rules for the next change (from `docs/convex-development.md`): new columns are
additive/optional first; the backfill is bounded, indexed and resumable; retry
and old/new compatibility are tested offline with `convex-test` (run the
schema-lifecycle suite twice to prove reset + retry); fields are tightened
only after the backfill completed and only in a later, separately tested
release. Never an unbounded `.collect()` in a production function.

### 5.3 Worker retries (the retry surfaces and their budgets)

| Retry loop | Budget | Where |
| --- | --- | --- |
| Ingestion jobs | 5 attempts (configurable, clamped), 30 s doubling backoff capped at 15 min, 120 s lease, then dead letter; deterministic input problems go straight to `unsupported` and are never retried; one cycle every 5 minutes claims ≤10 jobs | `packages/api/convex/ingestion.ts`, `crons.ts` |
| Tutor turns | `TUTOR_MAX_ATTEMPTS` default 3 (clamped 1..5) on **transient** failures only (`RATE_LIMITED` honours `Retry-After`, timeout, provider error); policy blocks, unsupported capability, oversized input, malformed response and cancellation fail immediately | `packages/worker/src/tutor/turn.ts` |
| Browser transcription | at most 2 attempts, never before the declared `Retry-After`/`retryAfterMs`, never truncated to retry early, abortable | `packages/app/src/retryPolicy.ts` |
| Provider adapters | zero automatic retries; callers decide, `Retry-After` surfaces as `retryAfterMs` + header | `packages/worker/src/nan/` |
| Agent runtime | **no retry-with-upgrade**: a platform quota failure becomes a visible `AGENT_QUOTA_EXCEEDED` (507) | `packages/agent/src/quota.ts` |
| Uploads | one client idempotency key per file; `commitDocumentUpload` writes file row + document + job in one transaction, orphan blobs deleted immediately | `packages/api/convex/files.ts`, `documents.ts` |

### 5.4 Private storage

- Original document bytes live in Convex `_storage` behind the S05
  `privateFiles` registry; they are served only by the authenticated
  `GET /private-files/:fileId` HTTP action, which re-derives identity from
  `ctx.auth`, re-checks owner and project, and answers
  `Cache-Control: private, no-store` + `X-Content-Type-Options: nosniff`.
- `storage.getUrl()` is bearer access and is **never** returned for private
  documents or audio (README "Security"; `docs/convex-development.md` S05/S08).
- Uploads are capped (`MAX_UPLOAD_BYTES`, hard ceiling `10485760`, below
  Convex's 20 MiB HTTP-action limit), type-checked, extension-matched and
  content-sniffed before anything is stored.
- Deletion cascades in bounded batches (documents + blobs + chunks +
  embeddings + messages + citations + turns + telemetry + tokens), with a
  visible ledger and retriable failures (S04/S08/S22/S24).

### 5.5 Convex-authenticated agent entry points

The only way into a Durable Object (`docs/adr/0004`,
`docs/cloudflare-agent-runtime.md`):

1. An authenticated owner calls Convex `issueConnectionToken` (requires
   `ctx.auth` and a live owned project) and receives a 256-bit token bound to
   `ownerId + projectId`, TTL 300 s (max 900 s); only its SHA-256 hash is
   stored.
2. `POST /agent/session { token, reconnect? }` on the agent Worker verifies
   it against the Convex deployment (`/agent/connection-tokens/verify`, or
   `/agent/connection-tokens/reconnect` which rotates it) and returns the
   owner-scoped `instanceId` and `connectPath`.
3. `onBeforeConnect` / `onBeforeRequest` re-verify before any Durable Object
   is created, check `HMAC(AGENT_BRIDGE_SECRET, ownerId + projectId)` equals
   the requested instance name, strip client-supplied bridge/authorization
   headers and forward a signed short-lived `x-agent-session` header.
4. `onConnect` and **every** subsequent message/request re-verify the token
   against Convex before any state read or provider call, so revocation,
   rotation, expiry and scope violations stop the very next operation with a
   typed error (`CONNECTION_TOKEN_*`, `AGENT_SESSION_*`,
   `AGENT_SCOPE_MISMATCH`).

Identity never comes from a browser user id, an email or a client-chosen
instance name; Convex remains the authority on every operation.

## 6. Health-check gate: failed health checks BLOCK release

**Rule:** the gate is ordered and mandatory. A release (merge + production
deploy) proceeds only when every check below passes for that environment. A
single failure **blocks the release** — no partial pass, no "known flake"
override by the implementer; an override requires an explicit owner decision
recorded in the issue, with the failing output attached.

### 6.1 Gate order and stop criteria

| # | Check | Command | Pass criteria | If it fails |
| --- | --- | --- | --- | --- |
| G1 | Repository quality gates | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | all exit 0 | **Stop.** Fix, do not merge or deploy |
| G2 | Offline deploy dry-run / config shape (Section 7) | the Section 7 command block | prints `OK` on every step, no `FAIL` | **Stop.** The committed configuration is wrong for a Free/agent-only deployment |
| G3 | Client bundle leak inspection (Section 3.3) | build with fake `VITE_*`, then `grep` | `OK: client bundle carries no server/secret configuration, only the intended public VITE_* coordinate` | **Stop.** Treat as a suspected secret exposure: rotate anything real, then re-run |
| G4 | No tracked env/secret files | `git ls-files \| grep -E '(^\|/)\.env' \| grep -v '\.env\.example$'` and `git ls-files \| grep -E '\.dev\.vars' \| grep -v example` | both print nothing | **Stop.** Untrack before anything else (see `docs/ci-quality-gates.md`) |
| G5 | Convex compatibility *(live)* | `npx convex run internal.migrations.checkCompatibility '{}'` | `compatible: true`, `foundSchemaVersion: 12`, `expectedSchemaVersion: 12` | **Stop.** Run the current marker (Section 5.2), re-check; if still false, do not serve the new release |
| G6 | Anonymous access is denied *(live)* | `npx convex run projects.listProjects '{}'` | fails with `UNAUTHENTICATED` and returns no project data | **Stop.** Authorization regression: do not release (never weaken S05/S06 to pass) |
| G7 | Private file anonymous denial *(live)* | `curl -s -o /dev/null -w '%{http_code}\n' https://<deployment>.convex.site/private-files/fake-id` | `401` | **Stop.** Same reason as G6 |
| G8 | Agent gate closed *(live)* | `curl -s -X POST https://<worker>.workers.dev/agent/session -H 'content-type: application/json' -d '{}'` | a typed JSON error: `AGENT_BAD_MESSAGE` 400 (the `{}` body carries no token) or `AGENT_NOT_CONFIGURED` 503 (Worker without `AGENT_BRIDGE_SECRET`) — **never** `200`, never an `instanceId`/`connectPath`. `AGENT_TOKEN_MISSING` 401 is **not** reachable on this probe: it is raised by the instance-route gate (`packages/agent/src/gate.ts`), while `POST /agent/session` rejects a tokenless body before it calls Convex (`packages/agent/src/sessionEndpoint.ts`) | **Stop.** A session path without a Convex-verified token is a boundary breach |
| G9 | Free-plan posture *(live)* | Cloudflare dashboard plan = Free; Convex dashboard plan = Free; `npx convex deployment usage-limits list --prod`; `grep -E '"plan"\|"account_id"' packages/agent/wrangler.json` | plans are Free, limits configured per Section 4.2, grep prints nothing | **Stop.** Do not release against an unexpected plan; investigate before continuing |
| G10 | Config review test in CI | part of G1 (`packages/agent/tests/config.test.ts`, `packages/app/tests/no-provider-secrets.test.ts`) | passes | **Stop** |

**Targeting note for G5/G6:** `convex run` executes against the selected
development deployment unless you append `--prod` (default production
deployment) or `--deployment <ref>`; run each check against the environment
actually under test and record which target was used.

**Stop criteria (any one is sufficient):** a non-zero exit in G1–G4; a
non-empty "must be empty" output in G4/G9; `compatible: false` in G5; a
successful data read or a `2xx` in G6–G8; an unexpected plan in G9. On stop:
do not merge the release PR, do not run `npx convex deploy` or
`npx wrangler deploy` for that environment. If a deploy already happened,
start Section 9 recovery (roll back first), then re-run the full gate from G1.

G1–G4 and G10 are **offline** and were executed for this issue (recorded in
the PR test evidence). G5–G9 need a live deployment and are executed only
under deployment authority; this issue did not run them (no live calls).

## 7. Deploy dry-run / config validation with fake values (offline test evidence)

A complete, provider-free rehearsal of the configuration surface. It reads
only committed files, builds with **fake** coordinates and prints `OK`/`FAIL`.
No command below needs a credential, provisions anything, or writes to a
deployment. Outbound traffic is limited to wrangler's anonymous usage metrics,
plus a read-only lookup of an existing deployment if an account id happens to
be present in the shell (Section 0). Recorded output from this PR follows the
block.

```sh
set -e

# (1) Agent Worker deploy dry-run: wrangler compiles and checks without uploading.
#     Output must show the SQLite Durable Object binding and EMPTY vars, then
#     "--dry-run: exiting now."
pnpm --filter @learn-anything/agent build

# (2) Wrangler configuration shape: agent-only, Free-plan, no secret in vars.
node - <<'NODE'
const fs = require("node:fs");
const w = JSON.parse(fs.readFileSync("packages/agent/wrangler.json", "utf8"));
const forbidden = ["ai","assets","routes","zone_id","account_id","plan","workers_dev","kv_namespaces","d1_databases","r2_buckets","queues"];
const bad = forbidden.filter((k) => Object.hasOwn(w, k));
if (bad.length) { console.error("FAIL: forbidden keys " + bad.join(",")); process.exit(1); }
if (JSON.stringify(w.exports) !== JSON.stringify({ LearnerAgent: { type: "durable-object", storage: "sqlite" } })) {
  console.error("FAIL: Durable Object export must be sqlite-backed"); process.exit(1);
}
if (JSON.stringify(w.vars) !== JSON.stringify({ CONVEX_URL: "", NAN_DEPLOYER_ID: "" })) {
  console.error("FAIL: committed vars must be empty placeholders"); process.exit(1);
}
if ("AGENT_BRIDGE_SECRET" in w.vars || "NAN_API_KEY" in w.vars) {
  console.error("FAIL: secret name present in wrangler vars"); process.exit(1);
}
console.log("OK: wrangler.json is agent-only, SQLite-DO, secret-free, no plan key");
NODE

# (3) Committed examples are empty placeholders only.
grep -vE '^(#|$)' .env.example | grep -vE '^[A-Z0-9_]+=$' \
  && { echo "FAIL: non-empty value in .env.example"; exit 1; } \
  || echo "OK: .env.example holds empty values only"
grep -vE '^(#|$)' packages/agent/.dev.vars.example | grep -vE '^[A-Z0-9_]+=$' \
  && { echo "FAIL: non-empty value in .dev.vars.example"; exit 1; } \
  || echo "OK: .dev.vars.example holds empty values only"

# (4) Every key the runbook maps (Section 3.2) exists in the example file.
for k in NAN_API_KEY NAN_DEPLOYER_ID CONVEX_URL CONVEX_DEPLOYMENT SITE_URL \
         AUTH_REDIRECT_URIS JWT_PRIVATE_KEY JWKS VITE_CONVEX_URL \
         VITE_CONVEX_SITE_URL MAX_UPLOAD_BYTES RATE_LIMIT_REQUESTS \
         LOG_RETENTION_DAYS; do
  grep -q "^$k=$" .env.example || { echo "FAIL: missing $k"; exit 1; }
done
grep -q '^AGENT_BRIDGE_SECRET=$' packages/agent/.dev.vars.example \
  || { echo "FAIL: missing AGENT_BRIDGE_SECRET"; exit 1; }
echo "OK: documented key inventory matches the committed examples"

# (5) Build the client with FAKE coordinates, then prove no server/secret
#     configuration reached the bundle.
VITE_CONVEX_URL=https://fake-0000.convex.cloud \
VITE_CONVEX_SITE_URL=https://fake-0000.convex.site \
pnpm --filter @learn-anything/app build

if grep -rEn 'NAN_API_KEY|NAN_DEPLOYER_ID|AGENT_BRIDGE_SECRET|JWT_PRIVATE_KEY|GITHUB_CLIENT_SECRET|GOOGLE_CLIENT_SECRET|CONVEX_DEPLOYMENT|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|AUTH_REDIRECT_URIS|INGESTION_|RATE_LIMIT_|LOG_RETENTION' packages/app/dist; then
  echo "FAIL: server/secret name present in client bundle"; exit 1
fi
grep -q 'https://fake-0000.convex.cloud' packages/app/dist/assets/*.js \
  || { echo "FAIL: expected fake public coordinate missing"; exit 1; }
echo "OK: client bundle carries no server/secret configuration, only the intended public VITE_* coordinate"

# (6) Offline test suites that pin the same contract.
pnpm lint && pnpm typecheck && pnpm test && pnpm build
echo "OK: lint, typecheck, tests and build are green"

# (7) Vercel frontend configuration shape (issue #38): parse vercel.json and
#     assert the documented contract — framework/build/output, pinned Node
#     line, the required header set, and no secret name anywhere in the file.
node - <<'NODE'
const fs = require("node:fs");
const v = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (v.framework !== "vite") fail("framework must be vite");
if (v.installCommand !== "pnpm install --frozen-lockfile") fail("installCommand mismatch");
if (v.buildCommand !== "pnpm --filter @learn-anything/app build") fail("buildCommand mismatch");
if (v.outputDirectory !== "packages/app/dist") fail("outputDirectory mismatch");
if (!pkg.engines || pkg.engines.node !== "22.x") fail("engines.node must pin 22.x (CI runs Node 22.14.0)");
const rule = (v.headers || []).find((h) => h.source === "/(.*)");
if (!rule) fail("missing catch-all /(.*) header rule");
const headers = Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
const required = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "microphone=(self)",
};
for (const [k, want] of Object.entries(required)) {
  if (headers[k] !== want) fail(k + " must be " + want);
}
const csp = headers["Content-Security-Policy"] || "";
for (const d of ["default-src 'self'", "base-uri 'self'", "object-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "media-src 'self' blob:", "frame-ancestors 'none'", "form-action 'self'"]) {
  if (!csp.includes(d)) fail("CSP missing " + d);
}
if (/unsafe-(eval|inline)/.test(csp)) fail("CSP must not carry unsafe-eval/unsafe-inline");
const secrets = ["NAN_API_KEY", "NAN_DEPLOYER_ID", "AGENT_BRIDGE_SECRET", "JWT_PRIVATE_KEY", "JWKS", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET", "CONVEX_DEPLOYMENT", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CONVEX_DEPLOY_KEY"];
for (const s of secrets) if (JSON.stringify(v).includes(s)) fail("secret name " + s + " appears in vercel.json");
console.log("OK: vercel.json pins vite install/build/output + Node 22.x, required headers present, CSP strict, no secret name");
NODE
```

Why `npx convex deploy --dry-run` is not part of the offline block: the pinned
CLI prints `No CONVEX_DEPLOYMENT set` without a configured deployment, and
once a deployment name is supplied it fetches deployment metadata from
`api.convex.dev` (observed while writing this runbook: a fake name returned
`400 InvalidDeploymentName` from the API). It is therefore a **live**
preflight step — run it on an authenticated machine before pushing:

```sh
npx convex deploy --dry-run --typecheck enable --codegen enable   # (live)
```

It prints the generated configuration without deploying; any step failure
stops the following steps, which is also what makes a real `convex deploy`
safe to re-run (Section 9.2).

## 8. Backup, restore and rollback (and their limitations)

### 8.1 Backup *(live, authorized)*

```sh
# point-in-time export of one deployment, including file storage
npx convex export --path backups/convex-<env>-<YYYYMMDD>.zip --include-file-storage --prod
```

- Frequency: **before every migration-bearing release**, plus a weekly
  export; keep the newest N exports, encrypted, off-repository (an export
  contains the learner's documents, messages, auth tables — treat it as
  private data, never commit it, never paste it into an issue or PR).
- Frontend: on Vercel every deployment keeps its own immutable build output
  (`index.html` + hashed assets), so rollback is a promotion of a previous
  deployment (Section 8.3, section 13.6) and needs no rebuild. Still retain
  the last local `packages/app/dist` together with the `VITE_CONVEX_URL` it
  was built against for offline comparison and for any re-host decision.
- Agent Worker: version history is kept by Cloudflare
  (`npx wrangler versions list`); secrets are managed separately and are not
  part of any export.
- Durable Object state needs no backup (transient session state only).

### 8.2 Restore *(live, authorized; rehearse on staging first)*

```sh
npx convex import backups/convex-staging-<date>.zip --deployment staging   # drill on staging
npx convex import --append backups/convex-<date>.zip --prod                # additive restore
npx convex import --replace-all -y backups/convex-<date>.zip --prod        # destructive full restore
```

- `import` takes the snapshot path positionally and writes **into** a
  deployment (`--append` keeps existing rows, `--replace` replaces the named
  tables, `--replace-all` deletes everything not in the file); it is not an
  "undo". Rehearse on staging, then decide per incident whether restore,
  forward-fix or rollback (below) is right.
- After a restore, re-run Section 6 (G5–G9) before serving traffic: restored
  data must match the deployed schema/functions.

### 8.3 Rollback procedures

| Surface | Command | What it restores |
| --- | --- | --- |
| Convex functions/schema | `npx convex deploy` from the previous good commit *(live)* | Code. Only valid while the populated schema is compatible with that code (see limits) |
| Agent Worker | `npx wrangler rollback [version-id]` (identify with `npx wrangler versions list`) *(live)* | The previous Worker version. Secrets and Durable Object rows are untouched |
| Frontend (Vercel) | Instant Rollback to the previous deployment: `vercel rollback` or the dashboard's *Instant Rollback* on the deployment page *(live)* | The previous build's HTML/assets and its response headers, in seconds, without a rebuild |
| Order | Release: Convex → Worker → frontend. Rollback: frontend → Worker → Convex | Keeps clients off code whose backend is already gone |

### 8.4 Rollback limitations — where rollback is impossible

1. **Forward-only schema.** There is no downgrade migration. A populated
   deployment must stay on a compatible release until a *separately tested*
   downgrade exists (`docs/convex-development.md`).
2. **After a tightening migration.** Once optional fields have been backfilled
   and later made required (the documented sequence), rolling the code back
   would read rows the old code cannot validate — restore from an export
   instead, or ship a forward fix.
3. **After a table/index removal.** A table may be dropped only after no
   release reads it; if a release that needed it is rolled back later, the
   data is already gone — only an export restore can bring it back.
4. **Exports are point-in-time snapshots.** Recovery point = the last export;
   this repository runs no continuous backup, so anything written after the
   export is lost on restore.
5. **Worker rollback does not roll back secrets or Durable Object rows.** If
   a bad change was a secret value, roll back the secret itself with
   `wrangler secret put` (or `wrangler versions secret`), not just the code.
6. **Never delete the `LearnerAgent` export.** Deleting it tombstones the
   namespace (S07 rollback note); retire the Worker only via Cloudflare's
   documented deletion procedure, deliberately.
7. **Provider-side effects cannot be rolled back.** Data already sent to NaN
   (chunks, prompts, audio bytes) is outside this system's control and
   provider retention is unknown (`docs/provider-data-handling.md`).
8. **Version skew.** A frontend rollback against a newer backend (or the
   reverse) is safe only for additive releases; a non-additive release must
   be rolled back on both sides together, in the order above.

## 9. Recovery procedures

### 9.1 A migration failed midway

Symptoms: `bootstrapSchemaV12` returned `completed: false` or threw;
`checkCompatibility` reports `compatible: false` /
`foundSchemaVersion` older than 12.

1. **Do not roll back the code and do not hand-edit `schemaMetadata`.** New
   columns are optional, so the previous release can keep serving while the
   migration is unfinished.
2. Re-run the marker until it reports `completed: true`:

   ```sh
   npx convex run internal.migrations.bootstrapSchemaV12 '{}'   # (live; add --prod or --deployment <ref> for that environment)
   ```

   Bounded batches (100 rows) with a stored cursor make every re-run resume
   after the last processed row; a replayed batch is a no-op.
3. Re-run `npx convex run internal.migrations.checkCompatibility '{}'` and
   require `compatible: true` with `foundSchemaVersion: 12`.
4. Only then continue the release (Section 6, G5 onward).
5. If the migration still fails after three attempts: stop, capture the exact
   error text in the issue, leave the previous release serving, and escalate.
   Do not improvise data edits; a hand-written write to `schemaMetadata` or a
   half-applied backfill is a data-integrity incident, not a workaround.

### 9.2 A deployment is half-updated

- **Convex:** `convex deploy` runs ordered steps (typecheck → codegen →
  bundle → push) and stops at the first failure, so the failure is visible
  and re-runnable. Recovery: fix the cause, re-run
  `npx convex deploy` (idempotent, target confirmed with `--dry-run` first), then G5. If the push itself was
  interrupted, re-running from the last good commit is equally valid —
  pushes are whole-release, not partial-file.
- **Agent Worker:** identify the state with `npx wrangler versions list`,
  then either deploy the intended version again or `npx wrangler rollback`
  to the last known-good version. Secrets and DO rows persist across the
  rollback. Verify with G8.
- **Frontend:** run an Instant Rollback to the previous deployment
  (`vercel rollback` or the dashboard action, Section 8.3 / section 13.6); the
  new deployment's immutable assets mean no cache purge is required for the
  rolled-back hashes, and Vercel revalidates its edge on alias changes.
- **Always finish with the full gate (Section 6)** — a half-updated
  deployment is never "good enough to leave".

### 9.3 A quota is exhausted

Follow Section 4.3 (Convex) or Section 4.5 (Cloudflare): confirm with
`npx convex deployment usage --json` / the Workers dashboard, reduce usage or
wait for the reset (00:00 UTC daily; calendar month for monthly metrics),
re-run the health gate, and record the incident. **Never** "fix" a quota by
enabling a paid plan from a runbook.

### 9.4 Rollback is impossible — what then

Decide explicitly between (a) **forward fix** (preferred: additive release
that repairs the state) and (b) **export restore** (Section 8.2, loses data
written after the export). Record the choice, the data-loss window and the
evidence in the issue before acting. Provider-sent data (Section 8.4 item 7)
cannot be recovered either way.

## 10. Ordered preflight: restricted single-user deployment precedes any multiuser provider launch

This is an explicit **order**, not a suggestion. Steps are sequential; a
failed step stops the sequence.

1. **Confirm the restriction in configuration.** `NAN_DEPLOYER_ID` is set
   (Convex deployment var **and** Worker `vars`) to the deployer's own Convex
   user id, on every environment. The gate is a plain inequality
   (`learnerId !== deployerId`, `packages/worker/src/nan/policy.ts`), so an
   empty value blocks **every** learner rather than serving anyone:
   provider-backed routes answer `403 PROVIDER_POLICY_BLOCKED` /
   `NAN_POLICY_BLOCKED` / `TURN_POLICY_BLOCKED`. An empty `NAN_API_KEY`
   separately fails visibly with `*_NOT_CONFIGURED` — never a silent
   fallback.
2. **Run the offline dry-run** (Section 7) — green on every `OK`.
3. **Run the health gate for the target environment** (Section 6) — G1
   through G10 all pass, with G5–G9 executed under deployment authority.
4. **Deploy in the restricted shape** (dev → staging → prod), with the
   environment separation of Section 2 and the secret storage of Section 3.
5. **Post-deploy two-user probe (authorized environments only):** sign in as
   the deployer and confirm a provider-backed route works; create/sign in as
   a second synthetic account and confirm it receives the typed policy denial
   on provider routes (`403 PROVIDER_POLICY_BLOCKED` on STT,
   `TURN_POLICY_BLOCKED` on a tutor turn, `NAN_POLICY_BLOCKED` at the adapter)
   and `UNAUTHENTICATED`/`NOT_FOUND` on the first user's data. Record the
   exact codes in the issue.
6. **Record evidence and stop.** Single-user operation is the v0.1 steady
   state.

**Multiuser provider launch is blocked after step 6** until *all* of the
following exist and are recorded in this repository, then a separate reviewed
issue explicitly lifts the gate:

- the "must be agreed" list in `docs/provider-data-handling.md` (DPA,
  retention/deletion, no-training, sub-processors/residency, breach
  notification, credential custody, auditable answers);
- a credential model compatible with NaN's personal, non-transferable key
  terms (`docs/nan-provider-policy.md`) — pooling one deployer's key is
  prohibited, and "bring your own key" does not resolve custody;
- an explicit decision recorded as an ADR/issue.

This runbook grants no such authority. Nothing here provisions an account,
inserts a secret, activates production or contacts a provider.

## 11. Runbook review checklist (S25 acceptance criteria → sections)

| # | Acceptance criterion (issue #29) | Where it is addressed | Reviewer verifies |
| --- | --- | --- | --- |
| 1 | Secrets use deployment secret storage and are not bundled into client assets | Section 3 (storage classes, key-by-key map for every `.env.example` entry, leak-proof commands); Section 7 steps (3) and (5) | Every key has a per-environment home; the grep proof runs and prints `OK` |
| 2a | Separate dev/staging/prod configuration | Section 2.1 matrix + rules | No value copied across environments; `VITE_*` baked per environment |
| 2b | Convex Auth provider callback allowlists per environment | Section 2.2 table + OAuth/CORS rules + verification commands | `SITE_URL`/`AUTH_REDIRECT_URIS` exact-match, fail-closed, set per deployment |
| 2c | Convex Free ≠ metered Starter; quotas, usage alerts, recovery | Section 4.1 quotas, 4.2 `convex deployment usage` / `usage-limits`, 4.3 recovery path | Quotas recorded with check date; limits configured per environment; recovery is reduce/wait/owner-decision |
| 2d | Workers Free + SQLite DO verified; quota exhaustion must not trigger a billing upgrade | Section 4.4 (verified limits, sqlite export, config test) and 4.5 (behaviour on exceed, `AGENT_QUOTA_EXCEEDED` 507, the guard) | Limits match `docs/cloudflare-agent-runtime.md`; guard has no code path to a paid plan |
| 3a | Convex schema/data migrations, worker retries, private storage, Convex-authenticated agent entry points | Section 5.1–5.5 | Markers v12, resumable 100-row cursor batches, retry budgets table, `/private-files` auth, 4-step agent handshake |
| 3b | Cloudflare hosts agents only; no Access gate, no frontend hosting | Section 1 table + wrangler shape (Section 7 step 2) | Boundary stated plainly; `config.test.ts` enforces it |
| 4a | Backup/restore and rollback limitations | Section 8.1–8.4 (8 limitations listed) | Export/import commands documented; each impossible-rollback case named |
| 4b | Failed health checks block release | Section 6 gate table, stop criteria | G1–G10 with commands and pass criteria; explicit "blocks release" rule |
| 5 | Restricted single-user deployment precedes any multiuser provider launch | Section 10 ordered steps 1–6 and the blocked-until list | Order is sequential and gated; multiuser stays blocked with named prerequisites |
| 6 | Recovery: migration failed midway, half-updated deployment, rollback incl. impossible cases | Section 9.1, 9.2, 9.3, 9.4 | Rerun-until-`completed`, per-surface recovery, explicit impossible-rollback path |
| Test evidence | Deploy dry-run/config validation with fake values; runbook review | Section 7 (offline block + recorded output) and this table | Dry-run prints `OK` on every step from committed files; it never writes to a deployment (Section 0 documents the one ancillary network path) |

## 12. Operational limits and known gaps of this runbook

- **Documentation only.** No live deployment, provider call, secret insertion
  or provisioning happened for S25; G5–G9 and every *(live)* command are
  executed only under separate authorization.
- **Recheck dates.** Free quotas and Worker/DO limits were checked
  2026-10-02/03 against the linked vendor pages; plans, dashboard alert
  surfaces and CLI flags must be re-verified at each deployment.
- **Frontend hosting is Vercel** (ADR-0002 amended by issue #38; section 13),
  so Section 2 names the concrete Vercel origins instead of "any static/CDN
  host", and header/cache behaviour is whatever `vercel.json` plus Vercel's
  edge deliver — re-verified with `curl -I` on each deployment (a *(live)*,
  owner-authorized step; the 2026-10-03 QA found HSTS only).
- **Staging deployment reference** must be confirmed per Convex project
  (`npx convex env list --deployment staging` *(live)* lists that
  deployment's variables when the reference exists, and errors instead of
  listing when it does not; the dashboard shows the same); this runbook
  does not create one.
- **Alerts:** `usage-limits --type warning`/`disable` plus the dashboard notification
  surface plus an operator-owned monthly check are the three alert paths; the
  dashboard surface is marked "verify at provisioning" rather than assumed.
- **Backup frequency is an operator commitment**, not an automated job; no
  backup cron exists in this repository.
- **Password reset / email verification are unavailable** until an email or
  OAuth provider is configured (ADR-0004) — production sign-in recovery is a
  known gap, recorded here so it is not discovered during an incident.

## 13. Vercel web-client hosting (issue #38): configuration, headers, origins, rollback, free tier

**Documentation and configuration only.** Checked 2026-10-03 against `main` @
`d167217` with the pinned toolchain (`pnpm@10.20.0`, Node 22 line). Sources:
the published `vercel.json` schema (`https://openapi.vercel.sh/vercel.json`,
`additionalProperties: false`), Vercel's Node.js-version, limits and fair-use
pages (linked in the README's *Verified documentation*). **No Vercel project
was created or linked, no deployment was made, no dashboard setting was
changed, no secret was set and no provider was contacted for this issue** —
the live steps are owner authority and are listed in section 13.8. The
headers and config below take effect only on the next deployment that
contains them.

### 13.1 What the repository configures (`vercel.json` + Node pin)

| Key | Value in this repository | Why |
| --- | --- | --- |
| `$schema` | `https://openapi.vercel.sh/vercel.json` | Editor validation against the published schema |
| `framework` | `vite` | Preset for the `packages/app` Vite SPA (ADR-0001) |
| `installCommand` | `pnpm install --frozen-lockfile` | Same lockfile-locked install as CI |
| `buildCommand` | `pnpm --filter @learn-anything/app build` | Workspace-aware build; `VITE_*` values are read here at build time |
| `outputDirectory` | `packages/app/dist` | Vite's output for `packages/app` |
| `headers` | one catch-all rule `source: /(.*)` with six response headers | Section 13.2; applies to HTML and hashed assets alike |
| Root directory | repository root (no subdirectory Root Directory in project settings) | `vercel.json` lives at the repo root and drives the whole build |

- **Node version pin:** the published `vercel.json` schema has **no** Node
  version key, so the pin lives where Vercel reads it: `engines.node` in the
  root `package.json`, set to **`22.x`** (Vercel deploys the latest 22.x
  available; CI runs Node 22.14.0 on the same major). The previous `>=22`
  range would have resolved on Vercel to the newest available major instead,
  silently diverging from CI — narrowing it to `22.x` is the pin. Re-verify
  with `node -v` in the Build Command at the first deployment (Vercel doc:
  *Supported Node.js versions*).
- **No rewrites/redirects:** routing is hash-based
  (`packages/app/src/router.ts` writes `window.location.hash`), so every deep
  link is `/#/...` on the origin path `/`; no SPA rewrite rule is needed and
  `vercel.json` defines none (each rule would also count against the
  2048-routes-per-deployment limit).
- **No `devCommand`:** `vercel dev` falls back to the Vite framework default;
  local development keeps using the Vite dev server directly.

### 13.2 Security headers and microphone policy: required header → config line

Every row is one `headers[].headers[]` entry under `source: "/(.*)"` in
`vercel.json` (line numbers refer to that file):

| Required header | Config line (`vercel.json`) | Value | Why |
| --- | --- | --- | --- |
| Microphone policy | `headers[0].headers[Permissions-Policy]` | `microphone=(self)` | Voice UI: only this origin may capture the microphone; no other feature is granted |
| Content-Security-Policy | `headers[0].headers[Content-Security-Policy]` | see section 13.3 | Restricts script/style/connect/media/frame sources for the built bundle |
| Content-type protection | `headers[0].headers[X-Content-Type-Options]` | `nosniff` | No MIME sniffing of JS/CSS/media responses |
| Referrer control | `headers[0].headers[Referrer-Policy]` | `strict-origin-when-cross-origin` | Cross-origin requests carry only the origin; no path/query leak |
| Frame protection | `headers[0].headers[X-Frame-Options]` + CSP `frame-ancestors 'none'` | `DENY` + `'none'` | Defends older browsers (XFO) and CSP-capable ones (`frame-ancestors`) |
| HSTS | `headers[0].headers[Strict-Transport-Security]` | `max-age=31536000; includeSubDomains` | Pinned in-repo so the value is reviewable; Vercel also serves HSTS by default on `*.vercel.app`. No `preload` — preload requires an apex-domain commitment this repository does not make |

Context: the 2026-10-03 production QA on
`https://app-dun-seven-88.vercel.app` found HSTS but **no** `Permissions-Policy`,
`Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy` or
frame-protection header; these entries are the fix. They are frontend-only
controls — they say nothing about the Convex/Cloudflare surfaces, and they
are inert until the next Vercel deployment (owner authority). Offline proof
that the entries exist with the exact values is section 7 step (7) (`OK:
vercel.json pins vite install/build/output + Node 22.x, required headers
present, CSP strict, no secret name`). Live proof, after deployment *(live)*:

```sh
curl -sI https://app-dun-seven-88.vercel.app/ \
  | grep -Ei 'permissions-policy|content-security-policy|x-content-type-options|referrer-policy|x-frame-options|strict-transport-security'
```

### 13.3 The CSP fits the built app (verified against `dist/`)

The exact value:

```text
default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://*.convex.cloud wss://*.convex.cloud https://*.convex.site; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'
```

Evidence from the fake-coordinate build (section 7 step 5) on 2026-10-03:

- **No eval compatibility needed.** `grep -rEn 'eval\(|new Function'
  packages/app/dist/assets` → *no match*, so `script-src 'self'` holds without
  `'unsafe-eval'`.
- **No inline script or style.** `dist/index.html` contains exactly one
  external module script (`<script type="module" crossorigin
  src="/assets/index-*.js">`) and one external stylesheet
  (`<link rel="stylesheet" crossorigin href="/assets/index-*.css">`), and no
  `style="..."` attribute; the source tree has no `style=` attribute and no
  `<style>` injection — so no hashes, nonces or `'unsafe-inline'` are needed
  for `script-src`/`style-src`.
- **`connect-src` matches the only three network surfaces.** Convex sync: the
  client derives a `wss://` URL from `https://<deployment>.convex.cloud`
  (`convex/dist/esm/browser/sync/client.js`, `wsProtocol = "wss"`), so both
  schemes on `*.convex.cloud` are listed. HTTP actions built from
  `VITE_CONVEX_SITE_URL` (`/stt/transcribe`, `/tts/*`, `/private-uploads`,
  `/private-files`) are `https://*.convex.site`. `'self'` covers Vercel-hosted
  assets. A `grep` of all built origins finds only the intended coordinates
  plus documentation-link strings (`docs.convex.dev`, `react.dev`,
  `www.w3.org` namespaces) — nothing fetchable third-party. The two Convex
  platform host patterns are **not** an origin allowlist: identity redirects
  and CORS stay exact-match in `SITE_URL`/`AUTH_REDIRECT_URIS` (section 2.2),
  and the browser only ever connects to the single deployment baked into
  `VITE_CONVEX_URL`.
- **`media-src 'self' blob:`** — playback uses `URL.createObjectURL(audio)`
  (`packages/app/src/environments.ts:118`); microphone capture itself needs
  no fetch permission.
- **`img-src`/`font-src 'self' data:`** — no external font or image URL
  exists in `packages/app/src/styles.css` or the bundle.
- **`upgrade-insecure-requests` is deliberately omitted:** it would rewrite
  `http://localhost` requests during `vercel dev`, while every Vercel origin
  is already https.

Re-run this reasoning whenever the app starts loading a new origin, adding a
web worker/worklet, or using inline styles: the CSP must follow the bundle,
not the other way around.

### 13.4 Environment variables by name; no secret in repo or bundle

Names only — values live where the third column says, never here:

| Name | Class | Where it is set |
| --- | --- | --- |
| `VITE_CONVEX_URL` | public build coordinate | Vercel project environment (preview/production), read by `buildCommand` |
| `VITE_CONVEX_SITE_URL` | public build coordinate (optional; derived from `VITE_CONVEX_URL` when empty) | same |
| `SITE_URL`, `AUTH_REDIRECT_URIS` | exact-match allowlist (not secret) | Convex deployment variables, per environment (section 2.2, 13.5) |
| `JWT_PRIVATE_KEY`, `JWKS` | **secret** | Convex deployment variables only, generated per deployment — owner secrets workflow |
| `NAN_API_KEY`, `NAN_DEPLOYER_ID`, `AGENT_BRIDGE_SECRET`, OAuth client id/secret, tuning variables | secret/server config | Convex deployment variables and/or Worker secret store (section 3.2) |
| `CONVEX_DEPLOYMENT`, `CONVEX_DEPLOY_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | operator/CI credentials | gitignored local `.env` or CI secret store |

Nothing on that list appears in `vercel.json` (section 7 step (7) asserts the
secret names are absent) and NaN keys exist only in Convex env. The
bundle-level proof, recorded offline on 2026-10-03 after a build with
**fake** coordinates:

```sh
VITE_CONVEX_URL=https://fake-0000.convex.cloud \
VITE_CONVEX_SITE_URL=https://fake-0000.convex.site \
pnpm --filter @learn-anything/app build
grep -rEn 'NAN_API_KEY|NAN_DEPLOYER_ID|AGENT_BRIDGE_SECRET|JWT_PRIVATE_KEY|GITHUB_CLIENT_SECRET|GOOGLE_CLIENT_SECRET|CONVEX_DEPLOYMENT|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|AUTH_REDIRECT_URIS|INGESTION_|RATE_LIMIT_|LOG_RETENTION' packages/app/dist \
  || echo '(no matches: no server/secret name in dist/)'
grep -o 'https://fake-0000.convex.cloud' packages/app/dist/assets/*.js | head -1
```

```text
(no matches: no server/secret name in dist/)
https://fake-0000.convex.cloud
```

The same grep must be repeated against the **live** deployment's assets as
part of the post-deploy smoke (section 13.8); that live check is blocked with
the rest of the deployment steps.

### 13.5 Auth callback URLs / allowlist coverage for the Vercel origins (exact, no wildcards)

The allowlist is exact-match and fail-closed (`packages/api/convex/redirects.ts`,
`cors.ts`). Entries the owner sets *(live)*:

| Environment | Origin | `SITE_URL` value | `AUTH_REDIRECT_URIS` entries (comma-separated) |
| --- | --- | --- | --- |
| production | `https://app-dun-seven-88.vercel.app` (public production alias recorded in issue #38) | `https://app-dun-seven-88.vercel.app` | `https://app-dun-seven-88.vercel.app/#/`, `https://app-dun-seven-88.vercel.app/#/auth/callback` |
| per-deployment preview (Vercel-auth-protected), e.g. `https://app-igndwx413-andres-santos-projects.vercel.app` | the exact URL shown on that deployment | set as `SITE_URL` only on a **preview/staging** Convex deployment | matching `/#/` and `/#/auth/callback` origins of that URL, same environment |
| per-PR preview | branch-generated URL, known only after the deployment exists | same rule: preview/staging deployment only | same rule |

Rules:

- **Never a wildcard.** `https://app-*.vercel.app` or an origin pattern is
  rejected by the fail-closed check and must never be added; each preview
  origin is enumerated explicitly and only while needed.
- Production allowlist contains only production origins; a preview origin is
  never added to the production deployment's variables.
- OAuth provider callbacks are unchanged and stay on Convex:
  `${CONVEX_SITE_URL}/api/auth/callback/github|google` per deployment
  (section 2.2). Registering an OAuth app remains owner authority.
- Verification *(live)*: `npx convex env list --names-only --prod` plus
  `npx convex env get SITE_URL --prod` and a preview-environment equivalent.

### 13.6 Rollback and redeploy (frontend)

| Step | Command / action | Effect |
| --- | --- | --- |
| Redeploy current commit | push to `main`, or `vercel redeploy <deployment-url>` *(live)* | Rebuilds with the same env; headers come from that commit's `vercel.json` |
| Roll back the frontend | dashboard **Instant Rollback** on the last good deployment, or `vercel rollback` *(live)* | Reassigns the production alias to the previous immutable build (HTML/assets/headers) in seconds, no rebuild |
| Roll back a header/CSP change | Instant Rollback to the deployment built before the change | Headers are baked per deployment, so this reverts them with the code |
| Roll back build-time env | change the Vercel environment variable, then redeploy | `VITE_*` values are baked at build time; editing alone does nothing until a rebuild |
| Order | Release: Convex → agent Worker → frontend. Rollback: frontend → Worker → Convex | Section 8.3; keeps clients off code whose backend is already gone |

Frontend rollback cannot roll back Convex data (section 8.4 still applies to
the backend), and it does not touch Convex env variables.

### 13.7 Vercel Hobby free-tier limits (checked 2026-10-03)

| Limit | Hobby value | Notes for this app |
| --- | --- | --- |
| Use | **Non-commercial personal use only** | Commercial use requires a paid plan; the single-user v0.1 gate stays consistent with that |
| Fast Data Transfer | first **100 GB**/month | Static assets + SPA traffic |
| Fast Origin Transfer | first **10 GB**/month | Build/asset origin traffic |
| Build time | **45 minutes** per deployment | Current `vite build` is seconds; the limit fails a build visibly |
| Deployments | **100/day**, 100/hour, 60 per 5 minutes | Preview-per-PR is well inside it |
| Concurrent builds | **1** | Queued, not failed |
| Projects | 200 per account; 25 connected per Git repository | One project for this repository |
| Routes per deployment | **2048** (each header/rewrite/redirect counts) | This config uses 1 header rule |
| Environment variables | 1000 per environment; 64 KB total size | Names-only set from section 13.4 |
| Domains | 50 per project | Production alias + previews |
| Static upload size (CLI deploys) | 100 MB | Git-based deploys upload the repo, not `dist/` |
| Runtime logs | 1 hour retention | Static site has no runtime logs; build logs kept indefinitely |
| Functions | framework-dependent count; 10 s default duration on older non-Fluid setups | This app deploys **no** functions (static output only) |

No code or workflow in this repository enables a paid Vercel plan; exceeding
a quota fails visibly (build/traffic errors), and upgrading is a separate
owner decision — same guard as Convex/Cloudflare (sections 4.3, 4.5). Re-verify
these numbers on Vercel's limits/fair-use pages at deployment time.

### 13.8 Blocked pending owner authority (what issue #38 still needs)

1. **Secrets workflow for the Convex deployment:** set/verify
   `JWT_PRIVATE_KEY` and `JWKS` (and JWKS/origin configuration) through the
   authorized secrets workflow. Issue QA shows sign-in currently fails with
   `Missing environment variable JWT_PRIVATE_KEY`; this is not fixable from
   the repository.
2. **Deploying this configuration to Vercel:** linking/creating the Vercel
   project, dashboard settings (root directory, Node version confirmation,
   preview/production environment variables `VITE_CONVEX_URL` /
   `VITE_CONVEX_SITE_URL` by name) and the deployment itself. The headers in
   section 13.2 take effect only with that deployment.
3. **Preview/production smoke against the live URL:** sign-up/sign-in,
   `curl -I` header verification (section 13.2), and the no-secret-in-bundle
   grep against the deployed assets (section 13.4).
4. Two open UI follow-ups discovered during the same QA — **#67** (error copy)
   and **#68** — are tracked separately and are not part of this
   configuration change.

Issue #38 stays open until those live steps are recorded; this section is the
hand-off list.
