/**
 * Pure view state for S06 sign-in: the Convex React client reports
 * `isLoading` while it restores and refreshes a stored session, so an expired
 * or signed-out session must resolve to the sign-in view instead of an error.
 */
export type AuthView = "loading" | "sign-in" | "workspace";

export function deriveAuthView(state: { isLoading: boolean; isAuthenticated: boolean }): AuthView {
  if (state.isLoading) return "loading";
  return state.isAuthenticated ? "workspace" : "sign-in";
}

/**
 * Maps auth failures to fixed, safe copy. Raw provider messages are never
 * shown: they can echo an email address, an internal code or a stack trace.
 */
export function mapAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("TooManyFailedAttempts")) return "Too many attempts. Wait a few minutes and try again.";
  if (message.includes("Invalid password")) return "Passwords must be at least 8 characters.";
  if (message.includes("Invalid credentials") || message.includes("InvalidSecret") || message.includes("InvalidAccountId")) return "Email or password is incorrect.";
  if (message.includes("already exists")) return "An account with that email already exists.";
  if (message.includes("reset is not enabled") || message.includes("verification is not enabled")) return "That step needs an email provider, which this build does not have configured.";
  if (message.includes("Missing")) return "Enter your email and password.";
  return "Sign-in failed. Try again.";
}
