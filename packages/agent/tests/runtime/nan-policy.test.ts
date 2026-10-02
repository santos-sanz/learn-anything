import { expect, it } from "vitest";

import { connectAgent, installConvexMock, startSession, TEST_OWNER_TWO, TEST_PROJECT_TWO } from "./helpers.js";

const OWNER_TWO_TOKEN = "owner_two_nan_policy_token";

it("refuses NaN calls for a learner who is not the configured single-user deployer", async () => {
  installConvexMock([{ token: OWNER_TWO_TOKEN, ownerId: TEST_OWNER_TWO, projectId: TEST_PROJECT_TWO }]);

  const session = await startSession(OWNER_TWO_TOKEN);
  const connection = await connectAgent(session.connectPath, OWNER_TWO_TOKEN);
  await connection.next("session");

  // NAN_DEPLOYER_ID is `user_owner_1` in the test bindings, so owner two's
  // tutor turn is blocked by the S11 personal-key policy — visible, typed,
  // with no Workers AI or other provider fallback.
  connection.send({ type: "tutor.turn", turnId: "turn-policy-1", text: "Should never reach a provider." });
  const failure = await connection.next("error");
  expect(failure.code).toBe("NAN_POLICY_BLOCKED");
  expect(String(failure.message)).toContain("deployer");

  connection.close();
});
