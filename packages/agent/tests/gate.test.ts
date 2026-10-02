import { expect, test } from "vitest";

import type { FetchLike, ConvexVerifySuccess } from "../src/convexClient.js";
import { AGENT_SESSION_HEADER, deriveInstanceId, parseBridgeSession, SESSION_TOKEN_QUERY_PARAM } from "../src/scope.js";
import { gateAgentRequest, type GateEnv } from "../src/gate.js";

const SECRET = "test-not-a-real-bridge-secret";
const OWNER = "user_owner_1";
const PROJECT = "proj_owner_1_scope";
const TOKEN = "connection-token-value";

const ENV: GateEnv = { CONVEX_URL: "https://convex.test", AGENT_BRIDGE_SECRET: SECRET };

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

const wsRequest = (instanceId: string, query = `?${SESSION_TOKEN_QUERY_PARAM}=${TOKEN}`): Request =>
  new Request(`https://agent.test/agent/learner-agent/${instanceId}${query}`, { headers: { Upgrade: "websocket" } });

test("verifies the token, binds the instance and forwards a signed, sanitized request", async () => {
  const instanceId = await deriveInstanceId(SECRET, OWNER, PROJECT);
  const request = new Request(`https://agent.test/agent/learner-agent/${instanceId}?${SESSION_TOKEN_QUERY_PARAM}=${TOKEN}`, {
    headers: { Upgrade: "websocket", authorization: `Bearer ${TOKEN}`, [AGENT_SESSION_HEADER]: "spoofed-by-client" },
  });

  const gated = await gateAgentRequest(request, ENV, { name: instanceId }, fetchReturning(success()));
  expect(gated).toBeInstanceOf(Request);
  const forwarded = gated as Request;
  expect(forwarded.url).not.toContain(SESSION_TOKEN_QUERY_PARAM);
  expect(forwarded.headers.get("authorization")).toBeNull();
  expect(forwarded.headers.get(AGENT_SESSION_HEADER)).not.toBe("spoofed-by-client");

  const session = await parseBridgeSession(SECRET, forwarded.headers.get(AGENT_SESSION_HEADER));
  expect(session).toMatchObject({ token: TOKEN, ownerId: OWNER, projectId: PROJECT, instanceId });
  expect(session!.expiresAt).toBeGreaterThan(Date.now());
});

test("accepts a Bearer token for HTTP requests and strips it from the forwarded headers", async () => {
  const instanceId = await deriveInstanceId(SECRET, OWNER, PROJECT);
  const request = new Request(`https://agent.test/agent/learner-agent/${instanceId}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const gated = await gateAgentRequest(request, ENV, { name: instanceId }, fetchReturning(success()));
  expect(gated).toBeInstanceOf(Request);
  const forwarded = gated as Request;
  expect(forwarded.headers.get("authorization")).toBeNull();
  const session = await parseBridgeSession(SECRET, forwarded.headers.get(AGENT_SESSION_HEADER));
  expect(session?.token).toBe(TOKEN);
});

test("rejects missing tokens, non-GET methods and missing configuration before routing", async () => {
  const instanceId = await deriveInstanceId(SECRET, OWNER, PROJECT);

  const noToken = await gateAgentRequest(wsRequest(instanceId, ""), ENV, { name: instanceId }, fetchReturning(success()));
  expect(noToken).toBeInstanceOf(Response);
  expect((noToken as Response).status).toBe(401);
  expect(((await (noToken as Response).json()) as { code: string }).code).toBe("AGENT_TOKEN_MISSING");

  const post = await gateAgentRequest(new Request(`https://agent.test/agent/learner-agent/${instanceId}`, { method: "POST" }), ENV, { name: instanceId }, fetchReturning(success()));
  expect((post as Response).status).toBe(405);

  const noSecret = await gateAgentRequest(wsRequest(instanceId), { CONVEX_URL: "https://convex.test", AGENT_BRIDGE_SECRET: "" }, { name: instanceId }, fetchReturning(success()));
  expect((noSecret as Response).status).toBe(503);
  expect(((await (noSecret as Response).json()) as { code: string }).code).toBe("AGENT_NOT_CONFIGURED");

  const noConvex = await gateAgentRequest(wsRequest(instanceId), { CONVEX_URL: "", AGENT_BRIDGE_SECRET: SECRET }, { name: instanceId }, fetchReturning(success()));
  expect((noConvex as Response).status).toBe(503);
  expect(((await (noConvex as Response).json()) as { code: string }).code).toBe("AGENT_NOT_CONFIGURED");
});

test("surfaces typed Convex verification failures with the right statuses", async () => {
  const instanceId = await deriveInstanceId(SECRET, OWNER, PROJECT);

  const forged = await gateAgentRequest(wsRequest(instanceId), ENV, { name: instanceId }, fetchReturning({ ok: false, code: "CONNECTION_TOKEN_INVALID", httpStatus: 401 }));
  expect((forged as Response).status).toBe(401);
  expect(((await (forged as Response).json()) as { code: string }).code).toBe("CONNECTION_TOKEN_INVALID");

  const expired = await gateAgentRequest(wsRequest(instanceId), ENV, { name: instanceId }, fetchReturning({ ok: false, code: "CONNECTION_TOKEN_EXPIRED", httpStatus: 401 }));
  expect((expired as Response).status).toBe(401);

  const revoked = await gateAgentRequest(wsRequest(instanceId), ENV, { name: instanceId }, fetchReturning({ ok: false, code: "CONNECTION_TOKEN_REVOKED", httpStatus: 401 }));
  expect((revoked as Response).status).toBe(401);

  const scope = await gateAgentRequest(wsRequest(instanceId), ENV, { name: instanceId }, fetchReturning({ ok: false, code: "CONNECTION_TOKEN_SCOPE", httpStatus: 403 }));
  expect((scope as Response).status).toBe(403);

  const unavailable = await gateAgentRequest(wsRequest(instanceId), ENV, { name: instanceId }, fetchReturning({ ok: false, code: "AGENT_VERIFY_UNAVAILABLE", httpStatus: 502 }));
  expect((unavailable as Response).status).toBe(502);

  const unknownUpstream = await gateAgentRequest(wsRequest(instanceId), ENV, { name: instanceId }, fetchReturning({ ok: false, code: "INTERNAL_ERROR", httpStatus: 500 }));
  expect((unknownUpstream as Response).status).toBe(502);
  expect(((await (unknownUpstream as Response).json()) as { code: string }).code).toBe("AGENT_VERIFY_FAILED");
});

test("refuses a valid token presented at another user's instance name", async () => {
  const ownerTwoInstanceId = await deriveInstanceId(SECRET, "user_owner_2", "proj_owner_2_scope");
  const gated = await gateAgentRequest(wsRequest(ownerTwoInstanceId), ENV, { name: ownerTwoInstanceId }, fetchReturning(success()));
  expect((gated as Response).status).toBe(403);
  expect(((await (gated as Response).json()) as { code: string }).code).toBe("AGENT_SCOPE_MISMATCH");
});

test("refuses a verified token whose scope does not match the forwarded instance", async () => {
  const instanceId = await deriveInstanceId(SECRET, OWNER, PROJECT);
  const mismatched = await gateAgentRequest(wsRequest(instanceId), ENV, { name: instanceId }, fetchReturning(success({ ownerId: "user_owner_2" })));
  expect((mismatched as Response).status).toBe(403);
  expect(((await (mismatched as Response).json()) as { code: string }).code).toBe("AGENT_SCOPE_MISMATCH");
});
