# ADR-0003: package layout and versioned configuration

**Status:** Accepted
**Date:** 2026-10-02

## Context

The first scaffold must let the web client, Convex API and ingestion runner
evolve without importing private runtime configuration into browser code. It
also needs contracts that make owner/project scope, job retry behavior and
agent handshakes explicit. Convex deployments require versioned schema and
functions rather than SQL-migration assumptions, and Convex Auth configuration
is beta and must be pinned/tested. Relevant official references reviewed on
2026-10-02 are [Convex authentication](https://docs.convex.dev/auth/overview),
[Convex Auth configuration](https://labs.convex.dev/auth/config),
[Convex file uploads](https://docs.convex.dev/file-storage/upload-files), and
[Convex platform limits](https://docs.convex.dev/production/state/limits).

## Decision

S02 will scaffold one TypeScript workspace with four packages:

| Package | Responsibility | Public interface |
| --- | --- | --- |
| `packages/app` | React/Vite client, accessibility, microphone capture and playback | Typed UI/domain contracts from `shared`; typed Convex client calls; no provider secrets |
| `packages/api` | Convex schema, queries, mutations, actions, HTTP actions and auth checks | Versioned Convex function names/arguments/results; authenticated upload/job/turn operations |
| `packages/worker` | Ingestion stage implementation invoked by/resident with the Convex action boundary | Versioned job-stage input/result contracts; idempotency key and retryable error taxonomy |
| `packages/shared` | Runtime-neutral TypeScript contracts, validators, error codes and configuration schema | Import-only dependency for app/api/worker; no runtime secrets or platform SDK initialization |

The web/API/worker flow is: (1) app obtains an authenticated upload capability
from API, (2) app uploads and submits metadata, (3) API creates a scoped
ingestion job, (4) worker/action stages emit only versioned job-state results,
and (5) app reads authorized job/document/citation state. For a tutor turn the
app sends `{ projectId, turnId, transcript-or-audio-reference }`; API validates
identity and project ownership; the agent bridge receives only a short-lived
scoped identity; the result is `{ turnId, transcript, citations, audioReference,
status }`. Exact fields will be added as versioned shared contracts in their
respective stories.

Configuration is a **versioned, validated contract**, not an untracked
collection of environment names:

1. `packages/shared` defines a discriminated `configVersion` and schemas for
   public app config, server/API config and worker config.
2. A committed synthetic example contains only empty values and non-secret
   identifiers. Real environment files remain ignored and are never imported by
   `packages/app` except an explicitly public, allowlisted endpoint value.
3. Each compatible addition increments a documented schema revision; a
   breaking removal/meaning change increments the major config version and
   provides a migration/compatibility path. API, job and auth-contract changes
   follow the same rule and are released with their consumer changes.
4. Convex schema/function changes are committed with their versioned code. Any
   data change needing backfill supplies a resumable migration and compatibility
   check; it is not represented as a SQL migration.

## Consequences

- S02 can create a clean, dependency-directed workspace without selecting
  credentials or creating cloud resources.
- S03 and later stories must preserve backwards compatibility during a
  rollout or explicitly ship a migration and test synthetic reset/retry paths.
- Shared contracts contain no database client, browser-only API, Durable Object
  state, private document, audio, account export or secret.
- Configuration review becomes part of pull-request validation; a config change
  without a version, schema validation, example update and compatibility note
  is incomplete.
