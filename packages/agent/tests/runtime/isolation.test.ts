import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

import { deriveInstanceId } from "../../src/scope.js";
import {
  AGENT_ORIGIN,
  connectAgent,
  installConvexMock,
  startSession,
  TEST_OWNER_ONE,
  TEST_OWNER_TWO,
  TEST_PROJECT_ONE,
  TEST_PROJECT_TWO,
} from "./helpers.js";

const OWNER_ONE_TOKEN = "owner_one_token";
const OWNER_ONE_OTHER_PROJECT_TOKEN = "owner_one_token_other_project";
const OWNER_TWO_TOKEN = "owner_two_token";
const BRIDGE_SECRET = "test-not-a-real-bridge-secret";

it("gives each owner an unguessable, scope-specific instance id that never embeds identifiers", async () => {
  installConvexMock([
    { token: OWNER_ONE_TOKEN, ownerId: TEST_OWNER_ONE, projectId: TEST_PROJECT_ONE },
    { token: OWNER_ONE_OTHER_PROJECT_TOKEN, ownerId: TEST_OWNER_ONE, projectId: "proj_owner_1_other_scope" },
    { token: OWNER_TWO_TOKEN, ownerId: TEST_OWNER_TWO, projectId: TEST_PROJECT_TWO },
  ]);

  const sessionOne = await startSession(OWNER_ONE_TOKEN);
  const sessionTwo = await startSession(OWNER_TWO_TOKEN);

  expect(sessionOne.instanceId).not.toBe(sessionTwo.instanceId);
  for (const instanceId of [sessionOne.instanceId, sessionTwo.instanceId]) {
    expect(instanceId).toMatch(/^la_[0-9a-f]{32}$/);
    expect(instanceId).not.toContain(TEST_OWNER_ONE);
    expect(instanceId).not.toContain(TEST_OWNER_TWO);
    expect(instanceId).not.toContain(TEST_PROJECT_ONE);
    expect(instanceId).not.toContain(TEST_PROJECT_TWO);
    expect(instanceId).not.toContain("owner");
    expect(instanceId).not.toContain("proj");
  }

  // Derivation is deterministic per owner+project and impossible without the secret.
  expect(await deriveInstanceId(BRIDGE_SECRET, TEST_OWNER_ONE, TEST_PROJECT_ONE)).toBe(sessionOne.instanceId);
  expect(await deriveInstanceId("a-different-secret-value", TEST_OWNER_ONE, TEST_PROJECT_ONE)).not.toBe(sessionOne.instanceId);

  // Same owner, different project: a different, project-scoped instance.
  const sessionOneOtherProject = await startSession(OWNER_ONE_OTHER_PROJECT_TOKEN);
  expect(sessionOneOtherProject.instanceId).not.toBe(sessionOne.instanceId);
});

it("refuses user two's valid token on user one's instance at the gate", async () => {
  installConvexMock([
    { token: OWNER_ONE_TOKEN, ownerId: TEST_OWNER_ONE, projectId: TEST_PROJECT_ONE },
    { token: OWNER_TWO_TOKEN, ownerId: TEST_OWNER_TWO, projectId: TEST_PROJECT_TWO },
  ]);
  const sessionOne = await startSession(OWNER_ONE_TOKEN);

  // User two's token is genuinely valid for user two's own scope...
  const ownSession = await startSession(OWNER_TWO_TOKEN);
  expect(ownSession.instanceId).not.toBe(sessionOne.instanceId);

  // ...but presenting it at user one's instance is a scope violation (403),
  // and no Durable Object connection is established.
  const stolen = await exports.default.fetch(
    new Request(`${AGENT_ORIGIN}${sessionOne.connectPath}?token=${OWNER_TWO_TOKEN}`, { headers: { Upgrade: "websocket" } }),
  );
  expect(stolen.status).toBe(403);
  const body = (await stolen.json()) as { code: string };
  expect(body.code).toBe("AGENT_SCOPE_MISMATCH");

  // Same for the HTTP path with a bearer token.
  const stolenHttp = await exports.default.fetch(
    new Request(`https://agent.test${sessionOne.connectPath}`, { headers: { Authorization: `Bearer ${OWNER_TWO_TOKEN}` } }),
  );
  expect(stolenHttp.status).toBe(403);
});

it("keeps each user's agent state scoped to that user only", async () => {
  installConvexMock([
    { token: OWNER_ONE_TOKEN, ownerId: TEST_OWNER_ONE, projectId: TEST_PROJECT_ONE },
    { token: OWNER_TWO_TOKEN, ownerId: TEST_OWNER_TWO, projectId: TEST_PROJECT_TWO },
  ]);

  const sessionOne = await startSession(OWNER_ONE_TOKEN);
  const sessionTwo = await startSession(OWNER_TWO_TOKEN);

  const connectionOne = await connectAgent(sessionOne.connectPath, OWNER_ONE_TOKEN);
  const helloOne = await connectionOne.next("session");
  expect(helloOne.ownerId).toBe(TEST_OWNER_ONE);
  expect(helloOne.projectId).toBe(TEST_PROJECT_ONE);

  const connectionTwo = await connectAgent(sessionTwo.connectPath, OWNER_TWO_TOKEN);
  const helloTwo = await connectionTwo.next("session");
  expect(helloTwo.ownerId).toBe(TEST_OWNER_TWO);
  expect(helloTwo.projectId).toBe(TEST_PROJECT_TWO);
  expect(helloTwo.instanceId).not.toBe(helloOne.instanceId);

  connectionOne.send({ type: "state.read" });
  const stateOne = await connectionOne.next("state.read.result");
  expect(stateOne.ownerId).toBe(TEST_OWNER_ONE);
  expect(stateOne.projectId).toBe(TEST_PROJECT_ONE);
  expect(stateOne.instanceId).toBe(sessionOne.instanceId);

  connectionTwo.send({ type: "state.read" });
  const stateTwo = await connectionTwo.next("state.read.result");
  expect(stateTwo.ownerId).toBe(TEST_OWNER_TWO);
  expect(stateTwo.projectId).toBe(TEST_PROJECT_TWO);
  expect(stateTwo.instanceId).toBe(sessionTwo.instanceId);

  // User one's agent never reports user two's scope and vice versa.
  expect(stateOne.ownerId).not.toBe(TEST_OWNER_TWO);
  expect(stateTwo.ownerId).not.toBe(TEST_OWNER_ONE);

  connectionOne.close();
  connectionTwo.close();
});
