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

test("the callback allowlist accepts only the configured origin, and a foreign origin is rejected before any outbound request", async () => {
  const t = convexTest({ schema, modules });
  const callback = "/api/auth/callback/github?code=forged-code&state=forged-state";

  // Positive control: an allowlisted absolute URI round-trips through the
  // cookie, passes the allowlist and reaches the GitHub code exchange (which
  // the intercepting fetch records instead of performing).
  const allowed = await captureNetwork(() => t.fetch(callback, { headers: { cookie: "__Host-githubRedirectTo=https://app.example.test/" } }));
  expect(String(allowed.error)).not.toContain("REDIRECT_NOT_ALLOWED");
  expect(allowed.attempted.some((url) => url.includes("github.com"))).toBe(true);

  const foreign = [
    "https://evil.example.test/steal",
    "https://app.example.test.evil.example/steal",
    "https://evil.example.test/?next=https://app.example.test/",
    "//evil.example.test/steal",
    "https://*.example.test/",
    "javascript:alert(1)",
    "https://app.example.test/not-configured",
    "https://test-convex.example/",
  ];
  for (const redirectTo of foreign) {
    const { attempted, error } = await captureNetwork(() => t.fetch(callback, { headers: { cookie: `__Host-githubRedirectTo=${redirectTo}` } }));
    expect(String(error), redirectTo).toContain("REDIRECT_NOT_ALLOWED");
    expect(attempted, redirectTo).toEqual([]);
  }
});
