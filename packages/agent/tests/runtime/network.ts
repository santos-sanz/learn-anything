import { setupNetwork } from "@msw/cloudflare";

/**
 * Shared MSW network for the runtime suite. `setup.ts` enables it around each
 * test file; individual tests register handlers with `network.use(...)`.
 * Intercepted origins: the synthetic Convex deployment and the fixed NaN API
 * base URL. Nothing reaches the real network.
 */
export const network = setupNetwork();
