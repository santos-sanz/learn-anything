import { expect, test } from "vitest";

import { verifyAgentConnectionToken, type FetchLike } from "../src/convexClient.js";

const CONVEX_URL = "https://convex.test";
const TOKEN = "connection-token-value";

const successBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true,
  tokenId: "token_id_1",
  ownerId: "user_owner_1",
  projectId: "proj_owner_1_scope",
  issuedAt: Date.now() - 1_000,
  expiresAt: Date.now() + 300_000,
  verifyCount: 1,
  rotated: false,
  ...overrides,
});

const respond = (status: number, body: unknown): FetchLike => async () => Response.json(body, { status });

test("parses a successful S06 verify response and targets the verify route", async () => {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url);
    expect(JSON.parse(String(init?.body))).toEqual({ token: TOKEN });
    return Response.json(successBody());
  };
  const result = await verifyAgentConnectionToken(CONVEX_URL, TOKEN, { fetchImpl });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.ownerId).toBe("user_owner_1");
    expect(result.projectId).toBe("proj_owner_1_scope");
    expect(result.rotated).toBe(false);
  }
  expect(urls).toEqual(["https://convex.test/agent/connection-tokens/verify"]);
});

test("uses the reconnect route when rotation is requested and requires the replacement token", async () => {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    return Response.json(successBody({ rotated: true, token: "replacement-token" }));
  };
  const rotated = await verifyAgentConnectionToken(CONVEX_URL, TOKEN, { reconnect: true, fetchImpl });
  expect(rotated.ok).toBe(true);
  if (rotated.ok) expect(rotated.token).toBe("replacement-token");
  expect(urls).toEqual(["https://convex.test/agent/connection-tokens/reconnect"]);

  const missingToken = await verifyAgentConnectionToken(CONVEX_URL, TOKEN, { reconnect: true, fetchImpl: respond(200, successBody({ rotated: true })) });
  expect(missingToken).toEqual({ ok: false, code: "AGENT_VERIFY_FAILED", httpStatus: 502 });
});

test("maps forged, expired, revoked and scope failures to typed rejections", async () => {
  const forged = await verifyAgentConnectionToken(CONVEX_URL, TOKEN, { fetchImpl: respond(401, { code: "CONNECTION_TOKEN_INVALID" }) });
  expect(forged).toEqual({ ok: false, code: "CONNECTION_TOKEN_INVALID", httpStatus: 401 });

  const expired = await verifyAgentConnectionToken(CONVEX_URL, TOKEN, { fetchImpl: respond(401, { code: "CONNECTION_TOKEN_EXPIRED" }) });
  expect(expired).toMatchObject({ ok: false, code: "CONNECTION_TOKEN_EXPIRED", httpStatus: 401 });

  const revoked = await verifyAgentConnectionToken(CONVEX_URL, TOKEN, { fetchImpl: respond(401, { code: "CONNECTION_TOKEN_REVOKED" }) });
  expect(revoked).toMatchObject({ ok: false, code: "CONNECTION_TOKEN_REVOKED", httpStatus: 401 });

  const scope = await verifyAgentConnectionToken(CONVEX_URL, TOKEN, { fetchImpl: respond(403, { code: "CONNECTION_TOKEN_SCOPE" }) });
  expect(scope).toMatchObject({ ok: false, code: "CONNECTION_TOKEN_SCOPE", httpStatus: 403 });
});

test("fails closed on configuration, network and malformed responses", async () => {
  expect(await verifyAgentConnectionToken("", TOKEN, { fetchImpl: respond(200, successBody()) })).toEqual({ ok: false, code: "AGENT_NOT_CONFIGURED", httpStatus: 503 });
  expect(await verifyAgentConnectionToken("   ", TOKEN)).toEqual({ ok: false, code: "AGENT_NOT_CONFIGURED", httpStatus: 503 });
  expect(await verifyAgentConnectionToken(CONVEX_URL, "", { fetchImpl: respond(200, successBody()) })).toMatchObject({ code: "AGENT_TOKEN_MISSING" });

  const networkDown: FetchLike = async () => {
    throw new Error("connection refused");
  };
  expect(await verifyAgentConnectionToken(CONVEX_URL, TOKEN, { fetchImpl: networkDown })).toEqual({ ok: false, code: "AGENT_VERIFY_UNAVAILABLE", httpStatus: 502 });

  const notJson: FetchLike = async () => new Response("upstream html", { status: 200 });
  expect(await verifyAgentConnectionToken(CONVEX_URL, TOKEN, { fetchImpl: notJson })).toEqual({ ok: false, code: "AGENT_VERIFY_UNAVAILABLE", httpStatus: 502 });

  const malformed = await verifyAgentConnectionToken(CONVEX_URL, TOKEN, { fetchImpl: respond(200, { ok: true }) });
  expect(malformed).toEqual({ ok: false, code: "AGENT_VERIFY_FAILED", httpStatus: 502 });

  const upstreamError = await verifyAgentConnectionToken(CONVEX_URL, TOKEN, { fetchImpl: respond(500, { code: "INTERNAL_ERROR" }) });
  expect(upstreamError).toMatchObject({ ok: false, code: "INTERNAL_ERROR", httpStatus: 500 });
});

test("rejects an already-expired success payload", async () => {
  const result = await verifyAgentConnectionToken(CONVEX_URL, TOKEN, { fetchImpl: respond(200, successBody({ expiresAt: Date.now() - 1 })) });
  expect(result).toEqual({ ok: false, code: "CONNECTION_TOKEN_EXPIRED", httpStatus: 401 });
});
