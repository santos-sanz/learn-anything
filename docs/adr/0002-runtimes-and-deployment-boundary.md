# ADR-0002: runtimes and deployment boundary

**Status:** Accepted (amended 2026-10-03 by issue #38: web client hosting bound to Vercel)
**Date:** 2026-10-02

## Context

v0.1 needs an authorized API/data boundary, a stateful agent runtime, and a
resumable document-ingestion runner. The architecture must preserve a strict
identity and tenant boundary without provisioning paid infrastructure. The
current product upload cap is <=10 MiB.

Official limits reviewed on 2026-10-02 show that Convex generated upload URLs
support direct uploads (with a two-minute POST timeout), while a Convex HTTP
action request is limited to 20 MiB. Cloudflare Workers Free accepts up to 100
MB request bodies but permits only 10 ms CPU per HTTP request; its HTTP
wall-clock duration can remain open while the client remains connected, which
does not make CPU-heavy parsing suitable. A self-hosted Node worker has no
provider-defined upload/execution limit in these sources: limits would be
chosen and operated by us, adding a new hosting and operational boundary.

| Ingestion option | Upload limit relevant to v0.1 | Execution-time boundary | Deployment trade-off | Decision |
| --- | --- | --- | --- | --- |
| Convex actions + direct Convex upload | Product cap 10 MiB; direct upload URL has no file-size limit and a 2-minute upload POST timeout; HTTP action is 20 MiB | Convex runtime actions: 30 minutes; resumable stages keep retries bounded | Uses the existing authorized data boundary and storage | Chosen |
| Cloudflare Workers Free | 100 MB request body on Free | 10 ms CPU/request; no hard HTTP wall limit while connected | Appropriate for lightweight agent coordination, not document parsing/embedding orchestration | Rejected for ingestion |
| Self-hosted Node worker | Operator-defined | Operator-defined | Requires a separate host, patching, queue, observability and credentials boundary | Deferred |

Sources: [Convex file uploads](https://docs.convex.dev/file-storage/upload-files),
[Convex platform limits](https://docs.convex.dev/production/state/limits),
[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
and [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Decision

**API and data operations run through authorized Convex functions.** Convex owns
durable projects, documents, jobs, chunks, citations, messages and progress.
Every public function derives identity from Convex Auth and checks ownership and
project scope; a storage ID, browser-supplied user ID, email address, or agent
identifier is never authority.

**The agent runtime runs only on Cloudflare Workers Free, using the Agents SDK
and SQLite-backed Durable Objects.** Durable Objects contain transient
session/runtime state only, not the durable learning record. Workers Free
allows only SQLite-backed Durable Objects and fails further operations when a
free-tier limit is exceeded; those failures must be visible and safe, never
trigger a paid upgrade. Cloudflare is not an Access gate and does not host the
general frontend.

**Vercel (Hobby, free tier) hosts the web client, and only the web client**
(amendment, issue #38, 2026-10-03). The hosting boundary is therefore: Vercel
serves the static Vite build of `packages/app`; Convex hosts the backend
(functions, auth, storage, HTTP actions); Cloudflare Workers Free hosts only
the project-scoped agents. The repository carries the frontend contract it
can own: a headers-only `vercel.json` with the security-header set including
the microphone permission policy. The output directory and the rest of the
build contract live in Vercel project settings (owner authority) and were
recorded from the working production build of 2026-10-03: install `pnpm
install`, build `pnpm run build`, output `packages/app/dist`, Node version
24.x — two preview experiments on 2026-10-03 proved a root `vercel.json`
cannot override this project's output resolution
(`STATIC_BUILD_NO_OUT_DIR`; runbook section 13.1), and the root
`package.json` `engines.node` (`>=22`, satisfied by CI's Node 22.14.0) is the
workspace requirement that does **not** select the Vercel build Node
(verified: a `22.x` engines pin was ignored by Vercel). Convex Auth
redirect/CORS allowlists stay exact-match per environment (`SITE_URL`,
`AUTH_REDIRECT_URIS`); Vercel preview/production origins are added as exact
origins only, never wildcards. This ADR is documentation and configuration: it
creates no Vercel project, triggers no deployment, and changes no dashboard or
secret — those remain separate owner authority, as does setting
`JWT_PRIVATE_KEY`/`JWKS` for the Convex deployment.

**Ingestion uses resumable Convex actions** after the browser uploads a file to
Convex storage through an authorized upload URL. A job advances through small,
idempotent stages (validate, extract, chunk, embed, commit) and records a
retryable state. It enforces the product's <=10 MiB cap before work starts;
the cap deliberately remains below the 20 MiB HTTP-action request ceiling.
CPU-heavy extraction is not run on a Workers Free request. If the measured
work cannot fit bounded Convex action stages, the job fails visibly and a new
ADR must approve a Node-worker deployment rather than silently moving it.

**Convex Auth is the sole application identity layer.** The Cloudflare agent
handshake validates a selected Convex Auth JWT/OIDC contract or a short-lived,
server-issued scoped connection token, then revalidates scope on reconnect.
Cloudflare Access, an email-only binding, and a client-selected user ID are not
identity layers. Convex Auth is beta and supports OAuth, email OTP/magic-link,
and password methods; S06 selects and tests the concrete method.

NaN deployment is **self-hosted/single-user only**: the deployer's server-side
NaN key serves that deployer alone. The hosted multiuser product is blocked
until vendor-approved terms and a secure credential model are documented. This
is the deployment gate in the README's *Provider credentials and deployment
gate*; bringing a key is only a proposal, not authorization for third-party
key custody. [NaN terms](https://nan.builders/terms) and [Convex Auth](https://labs.convex.dev/auth)
are the governing provider/auth references.

## Consequences

- No paid plan, Cloudflare Access gate, Node worker, secret, or provider
  account is provisioned by this decision — and the Vercel amendment provisions
  nothing either: it binds configuration in this repository, while project
  creation, deployment, dashboard settings and the Convex auth secrets workflow
  stay owner authority.
- Ingestion tests must cover oversize rejection, failed/retried stages and two
  users; agent tests must cover forged, expired and reconnect tokens.
- Free quota exhaustion is an explicit operational error. It does not authorize
  an automatic upgrade, fallback provider, or unauthorised cross-user pooling.
- A hosted multiuser release remains blocked until the NaN credential gate is
  separately evidenced and approved.
