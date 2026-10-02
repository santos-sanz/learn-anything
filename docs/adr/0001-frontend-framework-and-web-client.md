# ADR-0001: frontend framework and web client

**Status:** Accepted
**Date:** 2026-10-02

## Context

The v0.1 client must be a TypeScript web application with an accessible,
responsive UI, browser microphone capture and playback, and a typed Convex
integration. It must remain deployable independently of the agent runtime.
Microphone capture is a browser capability: the client records a bounded turn,
shows its transcript for review, and then plays the returned audio; it does not
put audio or provider keys in the browser.

Two candidates were considered:

| Option | Accessible responsive UI and TypeScript | Microphone capture | Convex integration | Result |
| --- | --- | --- | --- | --- |
| React SPA built with Vite | Mature TypeScript and component ecosystem; semantic HTML and keyboard/focus behavior remain application responsibilities | Direct access to `getUserMedia`, `MediaRecorder`, and audio playback in browser components | Convex documents a React client and says Convex Auth supports a React SPA served from a CDN | Chosen |
| Next.js | TypeScript and accessible React UI are feasible | Browser-only capture requires client components and careful server/client boundaries | Convex has Next.js support, but its Convex Auth support is described as under active development | Not chosen for v0.1 |

The Convex documentation explicitly describes React client support and identifies
Convex Auth as usable by a React SPA, while noting that Auth is beta and
Next.js support is experimental/under active development. [Convex authentication
overview](https://docs.convex.dev/auth/overview) and [Convex Auth](https://labs.convex.dev/auth)
were reviewed on 2026-10-02.

## Decision

Use a **React TypeScript single-page application built with Vite** for
`packages/app`. It owns accessible responsive presentation and the browser
voice controls. The application will use semantic controls, visible focus,
keyboard-operable recording controls, transcript/error states, and captions or
transcripts alongside playback; these are acceptance obligations for the UI
stories, not guarantees supplied by the framework.

The app connects to Convex through the typed React client. It requests a
short-lived, authenticated upload URL or calls an authorized application
operation; it never calls NaN directly. The browser sends the selected
project's audio/text turn only to an authenticated API boundary and receives a
transcript, citations, and playable response reference. Frontend hosting is a
separate deployment decision: neither Vite nor this ADR assigns it to
Cloudflare Workers.

## Consequences

- S02 will create the app package with Vite, React and TypeScript; no framework
  dependency is introduced by this documentation-only change.
- Voice work must test permission denial, no microphone, recording cancellation,
  keyboard operation, and playback; continuous/realtime duplex voice remains
  out of scope.
- Server rendering is intentionally not required for v0.1. A future need for
  SEO or server-rendered pages requires a new ADR rather than silently changing
  the runtime boundary.
- Convex Auth's beta status requires pinning and compatibility tests when S06
  implements it.
