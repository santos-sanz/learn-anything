import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import { installAuthTestEnv, installOAuthTestEnv, TEST_CONVEX_SITE_URL } from "./helpers/authEnv.js";

// The OAuth provider is registered only when credentials exist; these are fake
// values for an offline test, never a real OAuth app.
installAuthTestEnv();
installOAuthTestEnv();

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/files.ts": () => import("../convex/files.js"),
  "../convex/http.ts": () => import("../convex/http.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
};

/** Runs a step with an intercepting fetch so any outbound call is recorded, not made. */
async function captureNetwork<T>(run: () => Promise<T>): Promise<{ attempted: string[]; result: T | null; error: unknown }> {
  const attempted: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    attempted.push(String(input));
    throw new Error("unexpected outbound network request");
  }) as typeof globalThis.fetch;
  let result: T | null = null;
  let error: unknown = null;
  try {
    result = await run();
  } catch (caught) {
    error = caught;
  } finally {
    globalThis.fetch = original;
  }
  return { attempted, result, error };
}

test("the configured GitHub provider points OAuth at the deployment callback", async () => {
  const t = convexTest({ schema, modules });
  const started = await t.action(api.auth.signIn, { provider: "github", params: { redirectTo: "/" } });
  expect(started.redirect ?? "").toContain("/api/auth/signin/github?code=");
  const path = new URL(started.redirect ?? "").pathname + new URL(started.redirect ?? "").search;
  const { attempted, result, error } = await captureNetwork(() => t.fetch(path));
  expect(error).toBeNull();
  expect(attempted).toEqual([]);
  expect(result?.status).toBe(302);
  const location = result?.headers.get("location") ?? "";
  expect(location).toContain("https://github.com/login/oauth/authorize");
  expect(location).toContain("client_id=gh-test-client");
  expect(location).toContain(encodeURIComponent(`${TEST_CONVEX_SITE_URL}/api/auth/callback/github`));
});

test("the OAuth callback rejects a redirect target outside the allowlist before any outbound request", async () => {
  const t = convexTest({ schema, modules });
  const { attempted, error } = await captureNetwork(() =>
    t.fetch("/api/auth/callback/github?code=forged-code&state=forged-state", {
      headers: { cookie: "__Host-githubRedirectTo=https://evil.example.test/steal" },
    }),
  );
  expect(String(error)).toContain("REDIRECT_NOT_ALLOWED");
  expect(attempted).toEqual([]);
});
