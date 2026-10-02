import { expect, test } from "vitest";

import { parseRedirectAllowlist, readRedirectAllowlist, redirectCallback, resolveRedirectTarget } from "../convex/redirects.js";

const SITE = "https://app.example.test";

test("the allowlist only keeps exact http(s) entries and drops wildcard or invalid ones", () => {
  expect(parseRedirectAllowlist(undefined)).toEqual([]);
  expect(parseRedirectAllowlist("  ")).toEqual([]);
  expect(parseRedirectAllowlist("https://a.example.test, https://a.example.test/")).toEqual(["https://a.example.test/"]);
  expect(parseRedirectAllowlist("https://*.example.test")).toEqual([]);
  expect(parseRedirectAllowlist("javascript:alert(1)")).toEqual([]);
  expect(parseRedirectAllowlist("not a url")).toEqual([]);
});

test("SITE_URL is always part of the configured allowlist", () => {
  expect(readRedirectAllowlist({ SITE_URL: SITE })).toEqual([`${SITE}/`]);
  expect(readRedirectAllowlist({ AUTH_REDIRECT_URIS: `${SITE}/welcome`, SITE_URL: SITE })).toEqual([`${SITE}/welcome`, `${SITE}/`]);
  expect(readRedirectAllowlist({})).toEqual([]);
});

test("configured redirect URIs resolve exactly and unconfigured ones are rejected", () => {
  const allowlist = readRedirectAllowlist({ AUTH_REDIRECT_URIS: `${SITE}/welcome`, SITE_URL: SITE });
  expect(resolveRedirectTarget("/", allowlist, SITE)).toBe(`${SITE}/`);
  expect(resolveRedirectTarget(`${SITE}/welcome`, allowlist, SITE)).toBe(`${SITE}/welcome`);
  expect(resolveRedirectTarget("/welcome", allowlist, SITE)).toBe(`${SITE}/welcome`);
});

test("foreign origins, wildcards and non-http targets never pass the allowlist", () => {
  const allowlist = readRedirectAllowlist({ SITE_URL: SITE });
  const rejected = [
    "https://evil.example.test/steal",
    "https://app.example.test.evil.example/steal",
    "//evil.example.test/steal",
    "https://*.example.test/",
    "javascript:alert(1)",
    "\\evil.example.test",
    "https://app.example.test/welcome",
    "",
  ];
  for (const target of rejected) expect(() => resolveRedirectTarget(target, allowlist, SITE)).toThrow("REDIRECT_NOT_ALLOWED");
});

test("no configuration rejects every absolute redirect instead of falling open", () => {
  expect(() => resolveRedirectTarget(`${SITE}/`, [], undefined)).toThrow("REDIRECT_NOT_ALLOWED: no redirect URI is configured");
  expect(() => resolveRedirectTarget(undefined, [], SITE)).toThrow("REDIRECT_NOT_ALLOWED: redirect target is missing");
});

test("the Convex Auth redirect callback enforces the allowlist from environment variables", async () => {
  const env = { AUTH_REDIRECT_URIS: `${SITE}/welcome`, SITE_URL: SITE };
  await expect(redirectCallback({ redirectTo: "/welcome" }, env)).resolves.toBe(`${SITE}/welcome`);
  await expect(redirectCallback({ redirectTo: "https://evil.example.test/" }, env)).rejects.toThrow("REDIRECT_NOT_ALLOWED");
});
