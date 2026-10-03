# ADR-0004: authentication method and agent session bridge

**Status:** Accepted
**Date:** 2026-10-02

## Context

ADR-0002 makes Convex Auth the sole application identity layer and leaves S06 to
select and test the concrete method. The method must work without a paid auth
SaaS, without Cloudflare Access, and without provisioning anything external.
Registering an OAuth app or configuring an email provider requires separate
user authority that this story does not have, so the configuration review below
is what actually decides the method.

Configuration review, checked 2026-10-02:

| Method | External configuration required | Available to S06 | Notes |
| --- | --- | --- | --- |
| OAuth GitHub / Google | Registered OAuth app (client id + secret) and the redirect URI `${CONVEX_SITE_URL}/api/auth/callback/<provider>` approved in that app | No | Preferred for a production sign-in, blocked only by registration authority; wired but configuration-gated |
| Email OTP / magic link | A configured email delivery provider plus its API key | No | Provider deliberately left empty; no sending code exists in this repository |
| Password | Nothing external: scrypt hashing runs inside Convex | Yes | Selected for v0.1 development sign-in |
| Password reset and email verification | An email provider passed to Convex Auth's `reset` / `verify` password options | No | Recovery gap recorded under Consequences |

Versions pinned for this decision: `@convex-dev/auth` **0.0.96** (beta, no
1.0 API stability promise), `@auth/core` 0.41.3 (its peer dependency; the exact pin keeps `pnpm audit --audit-level=high` at the pre-S06 baseline),
`convex` 1.43.0, `convex-test` 0.0.60, `react` 19.1.1 with
`ConvexAuthProvider` / `useConvexAuth` as the frontend binding, exercised by
`packages/app/tests/auth-view.test.ts` (expired or signed-out session renders
the sign-in view) and `packages/app/tests/sign-in-form.test.tsx` (labelled
credential fields, announced sign-in errors, the documented recovery gap).

## Decision

**Password is the S06 sign-in method; OAuth and email stay configured but
empty.** `packages/api/convex/auth.ts` always registers the `Password`
provider, and registers GitHub or Google only when *both* credentials for that
provider exist (`GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`
+ `GOOGLE_CLIENT_SECRET`). With no credentials configured the provider list is
`password` only and requesting another provider fails; a test asserts that
message. No email provider is registered at all, so OTP, magic link, email
verification and password reset are unreachable rather than half-configured.

**Session semantics are pinned in code, not left to defaults.** Access JWTs are
RS256, valid for 1 hour, signed with `JWT_PRIVATE_KEY` and published through
`/.well-known/jwks.json`; `convex/auth.config.ts` binds verification to this
deployment (`domain: process.env.CONVEX_SITE_URL`, `applicationID: "convex"`).
Sessions last 30 days total and 30 days inactive. Refresh tokens rotate on use
(Convex Auth's 10-second reuse window). On the client, `ConvexAuthProvider`
restores stored tokens, refreshes before expiry, and `useConvexAuth()` maps
state to loading / sign-in / workspace, so an expired session renders the
sign-in form instead of an error. Sign-out revokes outstanding agent
connection tokens first, then invalidates the Convex Auth session.

**Callback allowlist: exact configured URIs only, no wildcards.**
`packages/api/convex/redirects.ts` resolves `redirectTo` against `SITE_URL` and
accepts it only when it exactly equals an entry of `AUTH_REDIRECT_URIS`
(comma-separated) or `SITE_URL` itself. Wildcards, other origins, backslashes,
non-http(s) schemes and unconfigured paths are rejected with
`REDIRECT_NOT_ALLOWED` before any outbound request is made. Fail-closed: with
no configuration at all, every redirect target is rejected.

**The agent bridge is a short-lived scoped server-issued connection token.**
ADR-0002 allows either a validated JWT/OIDC contract or such a token; Cloudflare
does not accept Convex Auth tokens implicitly, and handing browser sessions to
the agent runtime is explicitly discouraged by Convex Auth, so S06 implements
the second option in `packages/api/convex/agentSessions.ts`:

- Issue: an authenticated owner calls `issueConnectionToken` for a project they
  own; the plaintext token (256-bit hex) is returned once and only its
  SHA-256 hash is stored, bound to `ownerId + projectId` (never an email
  address or a bare user id).
- Issue time enforces that binding rather than documenting it: the caller's
  Convex Auth subject must be a full `userId|sessionId` pair, so an identity
  that carries only an email address, only a user id, or half of that subject
  is rejected with `UNAUTHENTICATED` before any row is written. A stored
  record therefore cannot be bound to a partial identity.
- The verify and reconnect routes take the connection token alone. Any
  `ownerId`, `userId`, `email` or `projectId` fields in the request body are
  ignored, so possession of the secret — never a claimed identity — decides
  the scope.
- TTL defaults to 300 seconds and is capped at 900 seconds.
- Verify: `/agent/connection-tokens/verify` (HTTP, and the internal
  `verifyConnectionToken` mutation for `ctx.runMutation`) rejects forged
  tokens (`CONNECTION_TOKEN_INVALID`), expired tokens
  (`CONNECTION_TOKEN_EXPIRED`), revoked or already-rotated tokens presented
  again (`CONNECTION_TOKEN_REVOKED`, the replay case) and scope violations
  (`CONNECTION_TOKEN_SCOPE`), which include a deleted or foreign project and a
  signed-in caller that does not own the token.
- Reconnect: `/agent/connection-tokens/reconnect` revalidates and rotates — the
  presented token is revoked, a replacement is issued, so the old token is a
  rejected replay from that moment on.
- Cloudflare hosting of the agent itself, Durable Objects and quota handling
  remain **S07**; this ADR only defines the verification contract S07 consumes.

**Identity still comes only from `ctx.auth`.** `requireUserId` uses Convex
Auth's `getAuthUserId`, which splits the `userId|sessionId` subject, so
`ownerId` is the stable user id — never an email, never a session, never a
client-supplied value (S05 pattern unchanged).

## Consequences

- **Passwords without recovery are not a production default.** This build can
  create an account and sign in, but a learner who forgets a password has no
  recovery path. Production sign-in stays blocked until either an email
  provider is configured (enables password reset, email verification, OTP or
  magic link) or OAuth app credentials are supplied.
- Once OAuth credentials are supplied: set `SITE_URL`, add the exact redirect
  URIs to `AUTH_REDIRECT_URIS`, register
  `${CONVEX_SITE_URL}/api/auth/callback/github` (or `google`) in the OAuth
  app, and set the four `*_CLIENT_ID` / `*_CLIENT_SECRET` variables. The
  providers then appear without a code change; a test covers the currently
  disabled state and the callback allowlist.
- Once an email provider is supplied: add it to `convex/auth.ts` (as an
  `Email` provider or as `Password({ verify, reset })`) and configure its API
  key as a deployment variable; no schema change is needed.
- Convex Auth is beta (0.0.x). The exact version is pinned and an upgrade is a
  deliberate ADR change; regenerated `convex/_generated/` bindings are
  committed with it.
- Secrets stay out of the repository: `JWT_PRIVATE_KEY` and `JWKS` are
  generated per deployment, `.env.example` holds empty placeholders only, and
  tests generate an ephemeral key pair at runtime.
- Tests are offline: sign-in, refresh, expiry, sign-out, callback allowlist and
  agent token cases run against `convex-test`, and the OAuth tests assert that
  an intercepting `fetch` recorded zero outbound requests.

## Evidence

Every decision above is exercised offline; this table links each one to the
assertion that proves it. Nothing here needs a live provider, an OAuth app or
a secret.

| Decision | Evidence |
| --- | --- |
| Convex Auth beta version is pinned | `packages/api/package.json` (`@convex-dev/auth` `0.0.96`); the version paragraph above |
| Enabled methods: password always on, OAuth configuration-gated, no email provider | `packages/api/tests/auth.test.ts` — "OAuth stays disabled while the OAuth app credentials are not configured"; `packages/api/convex/auth.ts` |
| Frontend support tested | `packages/app/tests/auth-view.test.ts` — "an expired or signed-out session resolves to the sign-in view"; `packages/app/tests/sign-in-form.test.tsx` — "the sign-in form renders labelled credentials fields and the recovery gap" |
| Why: no paid auth SaaS and no OAuth registration authority | this file, "Context" configuration-review table |
| Session semantics pinned in code (1 h RS256, refresh rotation, sign-out) | `packages/api/tests/auth.test.ts` — sign-in, refresh, sign-out and JWKS tests |
| Callback allowlist: exact URIs, fail closed, foreign origin rejected | `packages/api/tests/redirects.test.ts`; `packages/api/tests/auth-callback.test.ts` — "the callback allowlist accepts only the configured origin, and a foreign origin is rejected before any outbound request" |
| Missing, forged, malformed and expired tokens are denied with typed codes | `packages/api/tests/auth-negative-tokens.test.ts` |
| Agent bridge: scoped identity, expiry, reconnect, no email-only or user-id-only binding | `packages/api/tests/agent-sessions.test.ts` — issue-session-bound, stored-binding and client-supplied-identity tests; `packages/agent/tests/sessionEndpoint.test.ts`, `packages/agent/tests/scope.test.ts`, `packages/agent/tests/gate.test.ts` |
