/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Convex deployment URL; empty or unset keeps the app offline. */
  readonly VITE_CONVEX_URL?: string | undefined;
}
