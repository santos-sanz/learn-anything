import { expect, test } from "vitest";

import { deriveAuthView, mapAuthError } from "../src/authView.js";

test("an expired or signed-out session resolves to the sign-in view", () => {
  expect(deriveAuthView({ isLoading: false, isAuthenticated: false })).toBe("sign-in");
  expect(deriveAuthView({ isLoading: true, isAuthenticated: false })).toBe("loading");
  expect(deriveAuthView({ isLoading: false, isAuthenticated: true })).toBe("workspace");
});

test("auth failures map to fixed copy and never echo provider internals", () => {
  expect(mapAuthError(new Error("InvalidSecret"))).toBe("Email or password is incorrect.");
  expect(mapAuthError(new Error("InvalidAccountId"))).toBe("Email or password is incorrect.");
  expect(mapAuthError(new Error("TooManyFailedAttempts"))).toBe("Too many attempts. Wait a few minutes and try again.");
  expect(mapAuthError(new Error("Invalid password"))).toBe("Passwords must be at least 8 characters.");
  expect(mapAuthError(new Error("Account learner@example.test already exists"))).toBe("An account with that email already exists.");
  const generic = mapAuthError(new Error("Unexpected failure with learner@example.test"));
  expect(generic).toBe("Sign-in failed. Try again.");
  expect(generic).not.toContain("learner@example.test");
});
