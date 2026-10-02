import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import { decodeAccessToken, EMAIL, installAuthTestEnv, PASSWORD, TEST_ISSUER } from "./helpers/authEnv.js";

// Deployment variables must exist before any convex/ module is imported.
installAuthTestEnv();

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/files.ts": () => import("../convex/files.js"),
  "../convex/http.ts": () => import("../convex/http.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
};
const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });

const signUpParams = { flow: "signUp", email: EMAIL, password: PASSWORD };

async function signInUp(t: ReturnType<typeof convexTest>) {
  const result = await t.action(api.auth.signIn, { provider: "password", params: signUpParams });
  if (result.tokens === null || result.tokens === undefined) throw new Error("expected tokens");
  return result.tokens;
}

test("password sign-in issues a short-lived access token and a revocable session", async () => {
  const t = convexTest({ schema, modules });
  const tokens = await signInUp(t);
  const payload = decodeAccessToken(tokens.token);
  expect(payload.iss).toBe(TEST_ISSUER);
  expect(payload.aud).toBe("convex");
  expect(payload.exp - payload.iat).toBe(3600);
  const [userId, sessionId] = payload.sub.split("|");
  expect(userId).not.toBe("");
  expect(sessionId).not.toBe("");
  const state = await t.run(async (ctx) => ({ users: await ctx.db.query("users").collect(), sessions: await ctx.db.query("authSessions").collect() }));
  expect(state.users).toHaveLength(1);
  expect(state.users[0]._id).toBe(userId);
  expect(state.sessions).toHaveLength(1);
  expect(state.sessions[0]._id).toBe(sessionId);
  expect(state.sessions[0].expirationTime).toBeGreaterThan(Date.now());
});

test("signed-in identity derives ownerId in ctx.auth functions and survives a session change", async () => {
  const t = convexTest({ schema, modules });
  const first = await signInUp(t);
  const firstSubject = decodeAccessToken(first.token).sub;
  const learner = t.withIdentity(identity(firstSubject));
  const project = await learner.mutation(api.projects.createProject, { name: "Spanish" });
  const stored = await t.run(async (ctx) => ctx.db.get(project));
  expect(stored?.ownerId).toBe(firstSubject.split("|")[0]);

  const second = await t.action(api.auth.signIn, { provider: "password", params: { flow: "signIn", email: EMAIL, password: PASSWORD } });
  if (second.tokens === null || second.tokens === undefined) throw new Error("expected tokens");
  const secondSubject = decodeAccessToken(second.tokens.token).sub;
  expect(secondSubject).not.toBe(firstSubject);
  expect(secondSubject.split("|")[0]).toBe(firstSubject.split("|")[0]);
  const secondSession = t.withIdentity(identity(secondSubject));
  expect(await secondSession.query(api.projects.listProjects, {})).toEqual([{ _id: project, name: "Spanish", createdAt: stored?.createdAt }]);

  const stranger = t.withIdentity(identity("stranger-user|stranger-session"));
  expect(await stranger.query(api.projects.listProjects, {})).toEqual([]);
  await expect(stranger.mutation(api.projects.createProject, { name: "Nope" })).resolves.toBeTruthy();
  await expect(t.query(api.projects.listProjects, {})).rejects.toThrow("UNAUTHENTICATED");
  await expect(t.mutation(api.agentSessions.revokeAllConnectionTokens, {})).rejects.toThrow("UNAUTHENTICATED");
});

test("refresh rotates tokens while an expired session stops refreshing", async () => {
  const t = convexTest({ schema, modules });
  const first = await signInUp(t);
  const refreshed = await t.action(api.auth.signIn, { refreshToken: first.refreshToken });
  if (refreshed.tokens === null || refreshed.tokens === undefined) throw new Error("expected refreshed tokens");
  expect(refreshed.tokens.refreshToken).not.toBe(first.refreshToken);
  expect(decodeAccessToken(refreshed.tokens.token).sub).toBe(decodeAccessToken(first.token).sub);

  await expect(t.action(api.auth.signIn, { refreshToken: "not-a-refresh-token" })).rejects.toThrow("Can't parse refresh token");
  await expect(t.action(api.auth.signIn, { refreshToken: `${"0".repeat(24)}|nonexistent-session` })).resolves.toEqual({ tokens: null });

  await t.run(async (ctx) => {
    const sessions = await ctx.db.query("authSessions").collect();
    for (const session of sessions) await ctx.db.patch(session._id, { expirationTime: Date.now() - 1 });
  });
  const expired = await t.action(api.auth.signIn, { refreshToken: refreshed.tokens.refreshToken });
  expect(expired.tokens).toBeNull();
});

test("sign-out deletes the session so a stale refresh token cannot be reused", async () => {
  const t = convexTest({ schema, modules });
  const tokens = await signInUp(t);
  const subject = decodeAccessToken(tokens.token).sub;
  await t.withIdentity(identity(subject)).action(api.auth.signOut, {});
  const state = await t.run(async (ctx) => ({ sessions: await ctx.db.query("authSessions").collect(), refreshTokens: await ctx.db.query("authRefreshTokens").collect() }));
  expect(state.sessions).toHaveLength(0);
  expect(state.refreshTokens).toHaveLength(0);
  const after = await t.action(api.auth.signIn, { refreshToken: tokens.refreshToken });
  expect(after.tokens).toBeNull();
});

test("the deployment publishes the JWKS used to verify Convex Auth tokens", async () => {
  const t = convexTest({ schema, modules });
  const response = await t.fetch("/.well-known/jwks.json");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { keys: { kty: string; alg: string }[] };
  expect(body.keys).toHaveLength(1);
  expect(body.keys[0].kty).toBe("RSA");
  expect(body.keys[0].alg).toBe("RS256");
});

test("OAuth stays disabled while the OAuth app credentials are not configured", async () => {
  const t = convexTest({ schema, modules });
  await expect(t.action(api.auth.signIn, { provider: "github", params: {} })).rejects.toThrow("Provider `github` is not configured");
  await expect(t.action(api.auth.signIn, { provider: "google", params: {} })).rejects.toThrow("Provider `google` is not configured");
});
