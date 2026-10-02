import { expect, test } from "vitest";

import { AgentError } from "../src/errors.js";
import { agentErrorForStorageFailure, FREE_PLAN_QUOTA_MESSAGE, isPlatformQuotaError } from "../src/quota.js";

test("recognises platform Free-plan quota failures", () => {
  expect(isPlatformQuotaError(new DOMException("Quota exceeded", "QuotaExceededError"))).toBe(true);
  expect(isPlatformQuotaError(new Error("This key has exceeded its storage limit"))).toBe(true);
  expect(isPlatformQuotaError(new Error("Worker exceeded resource limits"))).toBe(true);
  expect(isPlatformQuotaError(new Error("Error 1102: Worker exceeded resource limits"))).toBe(true);
  expect(isPlatformQuotaError(new Error("Request would exceed the free tier"))).toBe(true);
  expect(isPlatformQuotaError(new Error("row writes limit reached"))).toBe(true);
});

test("does not mislabel ordinary failures as quota exhaustion", () => {
  expect(isPlatformQuotaError(new Error("boom"))).toBe(false);
  expect(isPlatformQuotaError(new TypeError("not a function"))).toBe(false);
  expect(isPlatformQuotaError("quota")).toBe(false);
  expect(isPlatformQuotaError(null)).toBe(false);
});

test("maps quota exhaustion to a visible, no-upgrade message with Insufficient Storage", () => {
  const error = agentErrorForStorageFailure(new DOMException("Quota exceeded", "QuotaExceededError"));
  expect(error).toBeInstanceOf(AgentError);
  expect(error.code).toBe("AGENT_QUOTA_EXCEEDED");
  expect(error.httpStatus).toBe(507);
  expect(error.message).toBe(FREE_PLAN_QUOTA_MESSAGE);
  expect(error.message).toContain("Cloudflare Workers Free plan quota reached");
  expect(error.message).toContain("never upgrades to a paid plan automatically");
  expect(error.message).toContain("00:00 UTC");
});

test("keeps non-quota failures typed instead of hiding them", () => {
  const internal = agentErrorForStorageFailure(new Error("unexpected"));
  expect(internal.code).toBe("AGENT_INTERNAL");
  expect(internal.httpStatus).toBe(500);

  const provider = agentErrorForStorageFailure({ code: "NAN_RATE_LIMITED" });
  expect(provider.code).toBe("NAN_RATE_LIMITED");
});
