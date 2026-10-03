import { expect, test } from "vitest";

import type { ConvexVerifySuccess, FetchLike } from "../src/convexClient.js";
import { AGENT_SESSION_PATH, agentConnectPath } from "../src/routes.js";
import { deriveInstanceId } from "../src/scope.js";
import { handleSessionRequest } from "../src/sessionEndpoint.js";

const SECRET = "test-not-a-real-bridge-secret";
const OWNER = "user_owner_1";
const PROJECT = "proj_owner_1_scope";
const TOKEN = "connection-token-value";

const ENV = { CONVEX_URL: "https://convex.test", AGENT_BRIDGE_SECRET: SECRET };

const success = (overrides: Partial<ConvexVerifySuccess> = {}): ConvexVerifySuccess => ({
  ok: true,
  tokenId: "token_id_1",
  ownerId: OWNER,
  projectId: PROJECT,
  issuedAt: Date.now() - 1_000,
  expiresAt: Date.now() + 300_000,
  verifyCount: 1,
  rotated: false,
  ...overrides,
});

const fetchReturning = (result: ConvexVerifySuccess | { ok: false; code: string; httpStatus: number }): FetchLike => async () => {
  if (result.ok) return Response.json(result);
  return Response.json({ code: result.code }, { status: result.httpStatus });
};

const post = (body: unknown): Request =>
  new Request(`https://agent.test${AGENT_SESSION_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("exchanges a verified token for the owner-scoped connect path", async () => {
  const response = await handleSessionRequest(post({ token: TOKEN }), ENV, fetchReturning(success()));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const payload = (await response.json()) as { ok: boolean; instanceId: string; connectPath: string; rotated: boolean; expiresAt: number };
  const instanceId = await deriveInstanceId(SECRET, OWNER, PROJECT);
  expect(payload).toMatchObject({ ok: true, instanceId, rotated: false, expiresAt: expect.any(Number) });
  expect(payload.connectPath).toBe(agentConnectPath(instanceId));
  expect(payload.instanceId).not.toContain(OWNER);
  expect(payload.instanceId).not.toContain(PROJECT);
});

test("returns the replacement token when reconnect rotation succeeds", async () => {
  const response = await handleSessionRequest(post({ token: TOKEN, reconnect: true }), ENV, fetchReturning(success({ rotated: true, token: "replacement-token" })));
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { rotated: boolean; token?: string };
  expect(payload.rotated).toBe(true);
  expect(payload.token).toBe("replacement-token");
});

test("rejects bad requests, wrong methods and missing configuration visibly", async () => {
  const get = await handleSessionRequest(new Request(`https://agent.test${AGENT_SESSION_PATH}`), ENV, fetchReturning(success()));
  expect(get.status).toBe(405);

  const badJson = await handleSessionRequest(post("{not json"), ENV, fetchReturning(success()));
  expect(badJson.status).toBe(400);
  expect(((await badJson.json()) as { code: string }).code).toBe("AGENT_BAD_MESSAGE");

  const missingToken = await handleSessionRequest(post({}), ENV, fetchReturning(success()));
  expect(missingToken.status).toBe(400);

  const noSecret = await handleSessionRequest(post({ token: TOKEN }), { CONVEX_URL: "https://convex.test", AGENT_BRIDGE_SECRET: "" }, fetchReturning(success()));
  expect(noSecret.status).toBe(503);
  expect(((await noSecret.json()) as { code: string }).code).toBe("AGENT_NOT_CONFIGURED");

  const noConvex = await handleSessionRequest(post({ token: TOKEN }), { CONVEX_URL: "", AGENT_BRIDGE_SECRET: SECRET }, fetchReturning(success()));
  expect(noConvex.status).toBe(503);
  expect(((await noConvex.json()) as { code: string }).code).toBe("AGENT_NOT_CONFIGURED");
});

test("maps verification failures to typed statuses", async () => {
  const forged = await handleSessionRequest(post({ token: TOKEN }), ENV, fetchReturning({ ok: false, code: "CONNECTION_TOKEN_INVALID", httpStatus: 401 }));
  expect(forged.status).toBe(401);
  expect(((await forged.json()) as { code: string }).code).toBe("CONNECTION_TOKEN_INVALID");

  const scope = await handleSessionRequest(post({ token: TOKEN }), ENV, fetchReturning({ ok: false, code: "CONNECTION_TOKEN_SCOPE", httpStatus: 403 }));
  expect(scope.status).toBe(403);

  const unavailable = await handleSessionRequest(post({ token: TOKEN }), ENV, fetchReturning({ ok: false, code: "AGENT_VERIFY_UNAVAILABLE", httpStatus: 502 }));
  expect(unavailable.status).toBe(502);
  expect(((await unavailable.json()) as { code: string }).code).toBe("AGENT_VERIFY_UNAVAILABLE");
});

test("the connect path binds owner and project from the verified token, never from the request body", async () => {
  const response = await handleSessionRequest(post({ token: TOKEN, ownerId: "learner@example.test", projectId: "proj_attacker_scope", instanceId: "la_attacker" }), ENV, fetchReturning(success()));
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { instanceId: string; connectPath: string };

  const instanceId = await deriveInstanceId(SECRET, OWNER, PROJECT);
  expect(payload.instanceId).toBe(instanceId);
  expect(payload.connectPath).toBe(agentConnectPath(instanceId));
  expect(payload.instanceId).not.toBe(await deriveInstanceId(SECRET, "learner@example.test", "proj_attacker_scope"));
  expect(payload.instanceId).not.toBe("la_attacker");
});

test("an instance id can never be derived from an owner id or a project id alone", async () => {
  const instanceId = await deriveInstanceId(SECRET, OWNER, PROJECT);

  // Same owner, different project: a user-id-only binding would collide here.
  expect(await deriveInstanceId(SECRET, OWNER, "proj_owner_2_scope")).not.toBe(instanceId);
  expect(await deriveInstanceId(SECRET, OWNER, "")).not.toBe(instanceId);
  // Same project, different owner (including an email-shaped one).
  expect(await deriveInstanceId(SECRET, "user_owner_2", PROJECT)).not.toBe(instanceId);
  expect(await deriveInstanceId(SECRET, "learner@example.test", PROJECT)).not.toBe(instanceId);
  // Neither half is readable in the derived id.
  expect(instanceId).not.toContain(OWNER);
  expect(instanceId).not.toContain(PROJECT);
  expect(instanceId).not.toContain("learner@example.test");
});

test("a verified token that is only an email address or a bare user id never reaches a connect path", async () => {
  for (const credential of ["learner@example.test", OWNER]) {
    const response = await handleSessionRequest(post({ token: credential }), ENV, fetchReturning({ ok: false, code: "CONNECTION_TOKEN_INVALID", httpStatus: 401 }));
    expect(response.status, credential).toBe(401);
    expect(((await response.json()) as { code: string }).code, credential).toBe("CONNECTION_TOKEN_INVALID");
  }
});
