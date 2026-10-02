import { expect, test } from "vitest";

import { appPackageName } from "../src/index.js";

test("identifies the application package", () => {
  expect(appPackageName).toBe("app");
});
