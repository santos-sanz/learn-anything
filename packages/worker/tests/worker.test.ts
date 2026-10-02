import { expect, test } from "vitest";

import { workerEntryPoint } from "../src/index.js";

test("exposes an ingestion-runner entry point", () => {
  expect(workerEntryPoint).toBe("ingestion-runner");
});
