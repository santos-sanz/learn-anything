import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api } from "../convex/_generated/api.js";
import { allowedOrigin, readCorsAllowlist } from "../convex/cors.js";
import schema from "../convex/schema.js";
import { installAuthTestEnv, TEST_ISSUER, TEST_SITE_URL } from "./helpers/authEnv.js";

installAuthTestEnv();

// Synthetic offline credentials only; never a real provider key.
process.env.NAN_API_KEY = "synthetic-test-key";
process.env.NAN_DEPLOYER_ID = "owner-a";

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/files.ts": () => import("../convex/files.js"),
  "../convex/http.ts": () => import("../convex/http.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
  "../convex/stt.ts": () => import("../convex/stt.js"),
};
const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });

const originalFetch = globalThis.fetch;
const originalRedirectUris = process.env.AUTH_REDIRECT_URIS;

beforeEach(() => {
  globalThis.fetch = (async () => Response.json({ text: "synthetic transcript", language: "en", duration: 1 })) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedirectUris === undefined) delete process.env.AUTH_REDIRECT_URIS;
  else process.env.AUTH_REDIRECT_URIS = originalRedirectUris;
});

const AUDIO_BYTES = new Uint8Array([1, 2, 3, 4]);
const turnPath = (projectId: string) => `/stt/transcribe?projectId=${projectId}&language=en&turnId=turn-1`;

const preflight = (origin: string | null) => {
  const headers: Record<string, string> = {
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization, content-type",
  };
  if (origin !== null) headers["Origin"] = origin;
  return { method: "OPTIONS", headers };
};

test("the CORS allowlist is the configured site origin plus AUTH_REDIRECT_URIS origins", () => {
  expect(readCorsAllowlist({ SITE_URL: "https://app.example.test", AUTH_REDIRECT_URIS: "https://staging.example.test/app, https://app.example.test/" })).toEqual([
    "https://app.example.test",
    "https://staging.example.test",
  ]);
  expect(readCorsAllowlist({})).toEqual([]);
  expect(readCorsAllowlist({ SITE_URL: "*://wildcard.example.test", AUTH_REDIRECT_URIS: "not-a-url, ftp://files.example.test" })).toEqual([]);
  expect(allowedOrigin(null, ["https://app.example.test"])).toBeNull();
  expect(allowedOrigin("https://evil.example.test", ["https://app.example.test"])).toBeNull();
  expect(allowedOrigin("https://app.example.test", ["https://app.example.test"])).toBe("https://app.example.test");
});

test("the browser preflight is answered with 204 and the CORS headers without any authentication", async () => {
  const t = convexTest({ schema, modules });

  // Deliberately anonymous: a preflight never carries credentials, so the route must not ask for any.
  const response = await t.fetch(turnPath("not-a-project-id"), preflight(TEST_SITE_URL));

  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(response.headers.get("access-control-allow-origin")).toBe(TEST_SITE_URL);
  expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  const allowedHeaders = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  expect(allowedHeaders).toContain("authorization");
  expect(allowedHeaders).toContain("content-type");
  expect(response.headers.get("access-control-max-age")).toBe("86400");
  expect(response.headers.get("vary")).toContain("origin");
});

test("a real POST response carries Access-Control-Allow-Origin and Vary", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });

  const response = await a.fetch(turnPath(projectId), {
    method: "POST",
    headers: { Origin: TEST_SITE_URL, "content-type": "audio/webm" },
    body: AUDIO_BYTES,
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe(TEST_SITE_URL);
  expect(response.headers.get("vary")).toContain("origin");
});

test("an origin outside the allowlist is never echoed on the preflight or on the response", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice" });
  const foreign = "https://evil.example.test";

  const deniedPreflight = await t.fetch(turnPath(projectId), preflight(foreign));
  expect(deniedPreflight.status).toBe(204);
  expect(deniedPreflight.headers.get("access-control-allow-origin")).toBeNull();
  expect(deniedPreflight.headers.get("vary")).toContain("origin");

  const deniedResponse = await a.fetch(turnPath(projectId), {
    method: "POST",
    headers: { Origin: foreign, "content-type": "audio/webm" },
    body: AUDIO_BYTES,
  });
  expect(deniedResponse.status).toBe(200);
  expect(deniedResponse.headers.get("access-control-allow-origin")).toBeNull();
  expect(deniedResponse.headers.get("vary")).toContain("origin");

  // No header on either answer may widen the allowlist: never `*` next to `Authorization`.
  const values = [...deniedPreflight.headers.values(), ...deniedResponse.headers.values()];
  expect(values.some((value) => value.includes("*"))).toBe(false);
});

test("an origin configured in AUTH_REDIRECT_URIS is allowed", async () => {
  process.env.AUTH_REDIRECT_URIS = `${TEST_SITE_URL},https://staging.example.test/app`;
  const t = convexTest({ schema, modules });

  const response = await t.fetch(turnPath("not-a-project-id"), preflight("https://staging.example.test"));

  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe("https://staging.example.test");
});
