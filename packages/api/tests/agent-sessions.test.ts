import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api, internal } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import { decodeAccessToken, EMAIL, installAuthTestEnv, PASSWORD, TEST_ISSUER } from "./helpers/authEnv.js";
import { expectTypedCode } from "./helpers/typedError.js";

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

type AgentResponse = {
  ok?: boolean;
  code?: string;
  tokenId?: string;
  ownerId?: string;
  projectId?: string;
  issuedAt?: number;
  expiresAt?: number;
  verifyCount?: number;
  rotated?: boolean;
  token?: string;
};

const postAgent = (t: ReturnType<typeof convexTest>, path: string, body: unknown) =>
  t.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function signUp(t: ReturnType<typeof convexTest>): Promise<string> {
  const result = await t.action(api.auth.signIn, { provider: "password", params: { flow: "signUp", email: EMAIL, password: PASSWORD } });
  if (result.tokens === null || result.tokens === undefined) throw new Error("expected tokens");
  return decodeAccessToken(result.tokens.token).sub;
}

test("anonymous and foreign callers cannot issue or revoke connection tokens", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  await expect(t.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA })).rejects.toThrow("UNAUTHENTICATED");

  const issued = await a.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA });
  const b = t.withIdentity(identity("owner-b|session-2"));
  await expect(b.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA })).rejects.toThrow("NOT_FOUND");
  await expect(b.mutation(api.agentSessions.revokeConnectionToken, { tokenId: issued.tokenId })).rejects.toThrow("NOT_FOUND");
  await expect(b.mutation(api.agentSessions.revalidateConnectionToken, { token: issued.token, rotate: false })).rejects.toThrow("CONNECTION_TOKEN_SCOPE");
  await expect(b.query(api.projects.listProjects, {})).resolves.toEqual([]);
});

test("issue stores only a hash and the agent handshake accepts the presented secret", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  const issued = await a.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA });

  expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
  expect(issued.expiresAt - issued.issuedAt).toBe(300_000);
  const stored = await t.run(async (ctx) => ctx.db.get(issued.tokenId));
  expect(stored).toMatchObject({ ownerId: "owner-a", projectId: projectA, revokedAt: null, verifyCount: 0, authSessionId: "session-1" });
  expect(stored?.tokenHash).toHaveLength(64);
  expect(stored?.tokenHash).not.toBe(issued.token);

  const response = await postAgent(t, "/agent/connection-tokens/verify", { token: issued.token });
  expect(response.status).toBe(200);
  const body = (await response.json()) as AgentResponse;
  expect(body).toMatchObject({ ok: true, ownerId: "owner-a", projectId: projectA, rotated: false, verifyCount: 1 });
  expect(body.token).toBeUndefined();

  const direct = await t.mutation(internal.agentSessions.verifyConnectionToken, { token: issued.token, rotate: false });
  expect(direct).toMatchObject({ ownerId: "owner-a", projectId: projectA, rotated: false, verifyCount: 2 });
  expect(direct.token).toBeUndefined();
});

test("forged, malformed and empty tokens are rejected", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  await a.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA });

  for (const forged of ["0".repeat(64), "0".repeat(63), "not-hex-at-all-but-long-enough-to-not-be-empty"]) {
    const response = await postAgent(t, "/agent/connection-tokens/verify", { token: forged });
    expect(response.status).toBe(401);
    expect(((await response.json()) as AgentResponse).code).toBe("CONNECTION_TOKEN_INVALID");
  }
  await expect(t.mutation(internal.agentSessions.verifyConnectionToken, { token: "0".repeat(64), rotate: false })).rejects.toThrow("CONNECTION_TOKEN_INVALID");

  const malformed = [{}, { token: "" }, { token: 42 }];
  for (const body of malformed) {
    const rejected = await postAgent(t, "/agent/connection-tokens/verify", body);
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as AgentResponse).code).toBe("INVALID_BODY");
  }
});

test("an expired connection token is rejected even while the secret is correct", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  const issued = await a.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA });
  await t.run(async (ctx) => {
    await ctx.db.patch(issued.tokenId, { expiresAt: Date.now() - 1 });
  });

  const response = await postAgent(t, "/agent/connection-tokens/verify", { token: issued.token });
  expect(response.status).toBe(401);
  expect(((await response.json()) as AgentResponse).code).toBe("CONNECTION_TOKEN_EXPIRED");
  await expect(t.mutation(internal.agentSessions.verifyConnectionToken, { token: issued.token, rotate: false })).rejects.toThrow("CONNECTION_TOKEN_EXPIRED");
});

test("reconnect rotates the token so the previous one becomes a rejected replay", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  const issued = await a.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA });

  const reconnect = await postAgent(t, "/agent/connection-tokens/reconnect", { token: issued.token });
  expect(reconnect.status).toBe(200);
  const rotated = (await reconnect.json()) as AgentResponse;
  expect(rotated).toMatchObject({ ok: true, rotated: true, verifyCount: 0, projectId: projectA });
  expect(rotated.token).toMatch(/^[0-9a-f]{64}$/);
  expect(rotated.token).not.toBe(issued.token);

  const replay = await postAgent(t, "/agent/connection-tokens/verify", { token: issued.token });
  expect(replay.status).toBe(401);
  expect(((await replay.json()) as AgentResponse).code).toBe("CONNECTION_TOKEN_REVOKED");
  const replacement = await postAgent(t, "/agent/connection-tokens/verify", { token: rotated.token });
  expect(replacement.status).toBe(200);
  expect(((await replacement.json()) as AgentResponse).verifyCount).toBe(1);

  const rows = await t.run(async (ctx) => ctx.db.query("agentConnectionTokens").collect());
  expect(rows).toHaveLength(2);
  const old = rows.find((row) => row._id === issued.tokenId);
  expect(old).toMatchObject({ revokedAt: expect.any(Number), replacedBy: rotated.tokenId });
  const next = rows.find((row) => row._id === rotated.tokenId);
  expect(next).toMatchObject({ revokedAt: null });
});

test("a deleted project fails reconnect revalidation", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  const issued = await a.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA });
  await a.mutation(api.projects.requestProjectDeletion, { projectId: projectA });

  const response = await postAgent(t, "/agent/connection-tokens/verify", { token: issued.token });
  expect(response.status).toBe(403);
  expect(((await response.json()) as AgentResponse).code).toBe("CONNECTION_TOKEN_SCOPE");
});

test("sign-out revokes outstanding connection tokens before the session ends", async () => {
  const t = convexTest({ schema, modules });
  const subject = await signUp(t);
  const learner = t.withIdentity(identity(subject));
  const project = await learner.mutation(api.projects.createProject, { name: "A" });
  const issued = await learner.mutation(api.agentSessions.issueConnectionToken, { projectId: project });
  expect((await postAgent(t, "/agent/connection-tokens/verify", { token: issued.token })).status).toBe(200);

  expect(await learner.mutation(api.agentSessions.revokeAllConnectionTokens, {})).toEqual({ revoked: 1, remaining: false });
  await learner.action(api.auth.signOut, {});

  const replay = await postAgent(t, "/agent/connection-tokens/verify", { token: issued.token });
  expect(replay.status).toBe(401);
  expect(((await replay.json()) as AgentResponse).code).toBe("CONNECTION_TOKEN_REVOKED");
  const state = await t.run(async (ctx) => ({ sessions: await ctx.db.query("authSessions").collect() }));
  expect(state.sessions).toHaveLength(0);
  const tokens = subject.split("|");
  const [userId] = tokens;
  const refresh = await t.action(api.auth.signIn, { refreshToken: `${"0".repeat(24)}|${userId}` });
  expect(refresh.tokens).toBeNull();
});

test("issue clamps nothing silently: TTL bounds and single-token revocation are explicit", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  await expect(a.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA, ttlSeconds: 0 })).rejects.toThrow("INVALID_ARGUMENT");
  await expect(a.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA, ttlSeconds: 901 })).rejects.toThrow("INVALID_ARGUMENT");
  await expect(a.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA, ttlSeconds: 1.5 })).rejects.toThrow("INVALID_ARGUMENT");

  const issued = await a.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA, ttlSeconds: 1 });
  expect(issued.expiresAt - issued.issuedAt).toBe(1000);
  await a.mutation(api.agentSessions.revokeConnectionToken, { tokenId: issued.tokenId });
  const response = await postAgent(t, "/agent/connection-tokens/verify", { token: issued.token });
  expect(response.status).toBe(401);
  expect(((await response.json()) as AgentResponse).code).toBe("CONNECTION_TOKEN_REVOKED");

  const after = await a.mutation(api.agentSessions.revokeAllConnectionTokens, {});
  expect(after).toEqual({ revoked: 0, remaining: false });
});

test("a connection token can only be issued from a full Convex Auth session identity", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });

  // An email-only subject, a user-id-only subject and half of either are all
  // rejected: no stored record may ever be bound to a partial identity.
  const partialSubjects = ["learner@example.test", "owner-a", "owner-a|", "|session-1", ""];
  for (const subject of partialSubjects) {
    const partial = t.withIdentity(identity(subject));
    await expectTypedCode(partial.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA }), "UNAUTHENTICATED");
  }

  // The full session subject still issues, so the denials above are the guard
  // and not a broken fixture.
  await expect(a.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA })).resolves.toMatchObject({ token: expect.any(String) });
});

test("the stored binding is ownerId + projectId + session, never an email address", async () => {
  const t = convexTest({ schema, modules });
  const tokens = await t.action(api.auth.signIn, { provider: "password", params: { flow: "signUp", email: EMAIL, password: PASSWORD } });
  if (tokens.tokens === null || tokens.tokens === undefined) throw new Error("expected tokens");
  const subject = decodeAccessToken(tokens.tokens.token).sub;
  const [userId, sessionId] = subject.split("|");
  const learner = t.withIdentity(identity(subject));
  const project = await learner.mutation(api.projects.createProject, { name: "A" });
  const issued = await learner.mutation(api.agentSessions.issueConnectionToken, { projectId: project });

  const stored = await t.run(async (ctx) => ctx.db.get(issued.tokenId));
  expect(stored?.ownerId).toBe(userId);
  expect(stored?.ownerId).not.toBe(EMAIL);
  expect(stored?.authSessionId).toBe(sessionId);
  expect(stored?.projectId).toBe(project);
});

test("the handshake ignores client-supplied identities and rejects an email or user id presented as a token", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("owner-a|session-1"));
  const projectA = await a.mutation(api.projects.createProject, { name: "A" });
  const issued = await a.mutation(api.agentSessions.issueConnectionToken, { projectId: projectA });

  // Extra identity fields in the body are never trusted: the verified scope
  // comes from the stored record alone.
  const rebound = await postAgent(t, "/agent/connection-tokens/verify", {
    token: issued.token,
    ownerId: "owner-b",
    userId: "owner-b",
    email: "learner@example.test",
    projectId: "proj_owner_2",
  });
  expect(rebound.status).toBe(200);
  expect(((await rebound.json()) as AgentResponse)).toMatchObject({ ok: true, ownerId: "owner-a", projectId: projectA });

  // Possessing an email address or a bare user id is not a handshake.
  for (const credential of ["learner@example.test", "owner-a", "owner-a|session-1"]) {
    const rejected = await postAgent(t, "/agent/connection-tokens/verify", { token: credential });
    expect(rejected.status, credential).toBe(401);
    expect(((await rejected.json()) as AgentResponse).code, credential).toBe("CONNECTION_TOKEN_INVALID");
  }
});
