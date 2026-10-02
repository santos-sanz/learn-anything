import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

/**
 * Root test suite (Node). The Cloudflare runtime suite for `packages/agent`
 * runs in its own config against workerd via `@cloudflare/vitest-pool-workers`
 * (`packages/agent/vitest.runtime.config.ts`, chained from `pnpm test`), and is
 * excluded here because those files import `cloudflare:test`.
 */
const workerPackageSource = fileURLToPath(new URL("./packages/worker/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@learn-anything/worker": workerPackageSource,
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "packages/agent/tests/runtime/**"],
  },
});
