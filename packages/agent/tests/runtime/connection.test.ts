import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

import { connectAgent, installConvexMock, postSession, startSession, TEST_OWNER_ONE, TEST_PROJECT_ONE } from "./helpers.js";

const CONNECT_TOKEN = "connection_token_main";
const AGENT_WS_URL = "https://agent.test/agent/learner-agent";

it("rejects a WebSocket upgrade with no token before any Durable Object exists", async () => {
  installConvexMock([]);
  const response = await exports.default.fetch(new Request(`${AGENT_WS_URL}/la_deadbeefdeadbeefdeadbeefdeadbeef`, { headers: { Upgrade: "websocket" } }));
  expect(response.status).toBe(401);
  const body = (await response.json()) as { code: string };
  expect(body.code).toBe("AGENT_TOKEN_MISSING");
});

it("rejects forged, expired and out-of-scope tokens at the gate", async () => {
  installConvexMock([
    { token: "expired_connection_token", ownerId: TEST_OWNER_ONE, projectId: TEST_PROJECT_ONE, expiresAt: Date.now() - 1 },
    { token: "valid_wrong_path_token", ownerId: TEST_OWNER_ONE, projectId: TEST_PROJECT_ONE },
  ]);

  const forged = await postSession({ token: "never_issued_token" });
  expect(forged.status).toBe(401);
  expect(((await forged.json()) as { code: string }).code).toBe("CONNECTION_TOKEN_INVALID");

  const expired = await postSession({ token: "expired_connection_token" });
  expect(expired.status).toBe(401);
  expect(((await expired.json()) as { code: string }).code).toBe("CONNECTION_TOKEN_EXPIRED");

  // Valid token, but the requested instance name does not match the derived
  // owner-scoped instance id: the gate refuses before reaching the Durable Object.
  const mismatch = await exports.default.fetch(
    new Request(`${AGENT_WS_URL}/la_00000000000000000000000000000000?token=valid_wrong_path_token`, { headers: { Upgrade: "websocket" } }),
  );
  expect(mismatch.status).toBe(403);
  expect(((await mismatch.json()) as { code: string }).code).toBe("AGENT_SCOPE_MISMATCH");
});

it("reconnect rotates the token, rejects the old replay and keeps the same scoped instance", async () => {
  const mock = installConvexMock([{ token: CONNECT_TOKEN, ownerId: TEST_OWNER_ONE, projectId: TEST_PROJECT_ONE }]);

  const first = await startSession(CONNECT_TOKEN);
  const firstConnection = await connectAgent(first.connectPath, CONNECT_TOKEN);
  const hello = await firstConnection.next("session");
  expect(hello.instanceId).toBe(first.instanceId);
  firstConnection.send({ type: "state.read" });
  const state = await firstConnection.next("state.read.result");
  expect(state.instanceId).toBe(first.instanceId);

  // Rotation through the session endpoint (Convex /reconnect semantics).
  const reconnect = await postSession({ token: CONNECT_TOKEN, reconnect: true });
  expect(reconnect.status).toBe(200);
  const rotated = (await reconnect.json()) as { token?: string; instanceId?: string; rotated?: boolean };
  expect(rotated.rotated).toBe(true);
  const replacementToken = rotated.token!;
  expect(replacementToken).toBeTruthy();
  expect(rotated.instanceId).toBe(first.instanceId);
  expect(mock.registry.get(CONNECT_TOKEN)?.revoked).toBe(true);

  // The presented (old) token is now a rejected replay at the gate.
  const replay = await postSession({ token: CONNECT_TOKEN, reconnect: true });
  expect(replay.status).toBe(401);
  expect(((await replay.json()) as { code: string }).code).toBe("CONNECTION_TOKEN_REVOKED");
  const replayConnect = await exports.default.fetch(new Request(`${"https://agent.test"}${first.connectPath}?token=${CONNECT_TOKEN}`, { headers: { Upgrade: "websocket" } }));
  expect(replayConnect.status).toBe(401);

  // The replacement token reaches the SAME instance with its scope intact.
  const secondConnection = await connectAgent(first.connectPath, replacementToken);
  const secondHello = await secondConnection.next("session");
  expect(secondHello.instanceId).toBe(first.instanceId);
  expect(secondHello.ownerId).toBe(TEST_OWNER_ONE);
  secondConnection.send({ type: "state.read" });
  const secondState = await secondConnection.next("state.read.result");
  expect(secondState.instanceId).toBe(first.instanceId);
  expect(secondState.ownerId).toBe(TEST_OWNER_ONE);

  // The old connection fails its next operation (its token was rotated away)
  // with a visible session error.
  firstConnection.send({ type: "state.read" });
  const failure = await firstConnection.next("error");
  expect(["AGENT_SESSION_INVALID", "CONNECTION_TOKEN_REVOKED", "CONNECTION_TOKEN_INVALID"]).toContain(failure.code);
  expect(typeof failure.message).toBe("string");

  secondConnection.close();
  firstConnection.close();
});

it("serves HTTP session reads only with a valid in-scope bearer token", async () => {
  installConvexMock([{ token: CONNECT_TOKEN, ownerId: TEST_OWNER_ONE, projectId: TEST_PROJECT_ONE }]);
  const session = await startSession(CONNECT_TOKEN);

  const authorized = await exports.default.fetch(
    new Request(`https://agent.test${session.connectPath}`, { headers: { Authorization: `Bearer ${CONNECT_TOKEN}` } }),
  );
  expect(authorized.status).toBe(200);
  const payload = (await authorized.json()) as { ownerId: string; projectId: string; instanceId: string };
  expect(payload.ownerId).toBe(TEST_OWNER_ONE);
  expect(payload.projectId).toBe(TEST_PROJECT_ONE);
  expect(payload.instanceId).toBe(session.instanceId);

  const unauthorized = await exports.default.fetch(
    new Request(`https://agent.test${session.connectPath}`, { headers: { Authorization: "Bearer never_issued_token" } }),
  );
  expect(unauthorized.status).toBe(401);
});
