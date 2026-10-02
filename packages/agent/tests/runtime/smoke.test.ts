import { expect, it } from "vitest";

import { connectAgent, installConvexMock, MOCK_TUTOR_REPLY, startSession, TEST_OWNER_ONE, TEST_PROJECT_ONE } from "./helpers.js";

const SMOKE_TOKEN = "smoke_connection_token_1";

/**
 * Local SDK smoke test: exercises the pinned Agents SDK, the Worker entry,
 * the gate, the SQLite-backed Durable Object and the NaN adapter call path
 * end to end inside workerd, with all outbound calls mocked.
 */
it("hosts a scoped agent session end to end on the real runtime", async () => {
  installConvexMock([{ token: SMOKE_TOKEN, ownerId: TEST_OWNER_ONE, projectId: TEST_PROJECT_ONE }]);

  const session = await startSession(SMOKE_TOKEN);
  expect(session.instanceId.startsWith("la_")).toBe(true);

  const connection = await connectAgent(session.connectPath, SMOKE_TOKEN);
  const hello = await connection.next("session");
  expect(hello.instanceId).toBe(session.instanceId);
  expect(hello.ownerId).toBe(TEST_OWNER_ONE);
  expect(hello.projectId).toBe(TEST_PROJECT_ONE);

  connection.send({ type: "state.read" });
  const state = await connection.next("state.read.result");
  expect(state.instanceId).toBe(session.instanceId);
  expect(state.ownerId).toBe(TEST_OWNER_ONE);
  expect(state.projectId).toBe(TEST_PROJECT_ONE);
  expect(state.connections).toBe(1);

  connection.send({ type: "tutor.turn", turnId: "turn-smoke-1", text: "Explain photosynthesis." });
  const reply = await connection.next("tutor.turn.result");
  expect(reply.turnId).toBe("turn-smoke-1");
  expect(reply.reply).toBe(MOCK_TUTOR_REPLY);

  connection.send({ type: "ping" });
  const pong = await connection.next("pong");
  expect(typeof pong.serverTime).toBe("number");

  connection.close();
});
