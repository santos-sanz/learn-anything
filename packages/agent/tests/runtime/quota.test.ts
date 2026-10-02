import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import { LearnerAgent } from "../../src/index.js";
import { connectAgent, installConvexMock, startSession, TEST_OWNER_ONE, TEST_PROJECT_ONE } from "./helpers.js";

const QUOTA_TOKEN = "quota_simulation_token";

it("fails safely with a visible message when the Free-plan storage quota is exhausted", async () => {
  installConvexMock([{ token: QUOTA_TOKEN, ownerId: TEST_OWNER_ONE, projectId: TEST_PROJECT_ONE }]);
  const session = await startSession(QUOTA_TOKEN);
  const connection = await connectAgent(session.connectPath, QUOTA_TOKEN);
  await connection.next("session");

  // Quota-exhaustion simulation: the platform refuses the next storage write,
  // exactly like exceeding a Workers/Durable Objects Free tier limit.
  const stub = env.LearnerAgent.getByName(session.instanceId);
  await runInDurableObject(stub, (instance: LearnerAgent) => {
    instance.faultNextStorageWrite = new DOMException("Quota exceeded: storage limit reached", "QuotaExceededError");
  });

  connection.send({ type: "state.read" });
  const quota = await connection.next("error");
  expect(quota.code).toBe("AGENT_QUOTA_EXCEEDED");
  expect(String(quota.message)).toContain("Cloudflare Workers Free plan quota reached");
  expect(String(quota.message)).toContain("never upgrades to a paid plan automatically");

  // Further operations fast-fail with the same visible message (no upgrade attempt).
  connection.send({ type: "state.read" });
  const again = await connection.next("error");
  expect(again.code).toBe("AGENT_QUOTA_EXCEEDED");
  expect(String(again.message)).toContain("never upgrades to a paid plan automatically");

  // The HTTP path surfaces the same typed failure with Insufficient Storage.
  const http = await exports.default.fetch(
    new Request(`https://agent.test${session.connectPath}`, { headers: { Authorization: `Bearer ${QUOTA_TOKEN}` } }),
  );
  expect(http.status).toBe(507);
  expect(((await http.json()) as { code: string }).code).toBe("AGENT_QUOTA_EXCEEDED");

  connection.close();
});
