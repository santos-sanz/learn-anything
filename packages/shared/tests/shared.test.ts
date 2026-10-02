import { expect, test } from "vitest";

import { contractVersion } from "../src/index.js";

test("exposes the initial contract version", () => {
  expect(contractVersion).toBe("0");
});
