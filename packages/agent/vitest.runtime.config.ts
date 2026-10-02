import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * S07 local SDK smoke and runtime suite: runs the real Agents SDK, the real
 * Durable Object and SQLite storage inside workerd via
 * `@cloudflare/vitest-plugin`. Outbound Convex and NaN calls are intercepted
 * with MSW (`@msw/cloudflare`) in `tests/runtime/setup.ts`, so this suite
 * performs no network I/O, needs no live secrets and consumes no provider
 * quota. Synthetic bindings are injected here; no secret is committed.
 */
const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const workerPackageSource = fileURLToPath(new URL("../worker/src/index.ts", import.meta.url));

export default defineConfig({
  root: packageRoot,
  resolve: {
    alias: {
      "@learn-anything/worker": workerPackageSource,
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "wrangler.json",
      },
      miniflare: {
        bindings: {
          CONVEX_URL: "https://convex.test",
          AGENT_BRIDGE_SECRET: "test-not-a-real-bridge-secret",
          NAN_API_KEY: "test-not-a-real-nan-key",
          NAN_DEPLOYER_ID: "user_owner_1",
        },
      },
    }),
  ],
  test: {
    include: ["tests/runtime/**/*.test.ts"],
    setupFiles: ["tests/runtime/setup.ts"],
  },
});
