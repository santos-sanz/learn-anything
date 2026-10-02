import { expect, test } from "vitest";

import { apiEntryPoint } from "../src/index.js";

test("exposes a Convex functions entry point", () => {
  expect(apiEntryPoint).toBe("convex-functions");
});
