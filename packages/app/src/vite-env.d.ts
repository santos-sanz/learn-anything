/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Convex deployment URL; empty or unset keeps the app offline. */
  readonly VITE_CONVEX_URL?: string | undefined;
  /** Optional explicit HTTP-actions origin; otherwise derived from VITE_CONVEX_URL. */
  readonly VITE_CONVEX_SITE_URL?: string | undefined;
}
