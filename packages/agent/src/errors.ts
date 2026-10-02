/**
 * Typed, visible error codes for the agent runtime. Every failure the client
 * can observe carries one of these codes plus a human-readable message; no
 * stack, secret, owner id or project id ever leaks through an error body.
 */
export type AgentErrorCode =
  | "AGENT_TOKEN_MISSING"
  | "AGENT_NOT_CONFIGURED"
  | "AGENT_VERIFY_UNAVAILABLE"
  | "AGENT_VERIFY_FAILED"
  | "AGENT_SCOPE_MISMATCH"
  | "AGENT_UNAUTHENTICATED"
  | "AGENT_SESSION_EXPIRED"
  | "AGENT_SESSION_INVALID"
  | "AGENT_SESSION_FORGED"
  | "AGENT_BAD_MESSAGE"
  | "AGENT_NOT_FOUND"
  | "AGENT_QUOTA_EXCEEDED"
  | "AGENT_INTERNAL"
  | "CONNECTION_TOKEN_INVALID"
  | "CONNECTION_TOKEN_EXPIRED"
  | "CONNECTION_TOKEN_REVOKED"
  | "CONNECTION_TOKEN_SCOPE"
  | "NAN_PROVIDER_ERROR"
  | "NAN_POLICY_BLOCKED"
  | "NAN_RATE_LIMITED"
  | "NAN_TIMEOUT"
  | "NAN_CANCELLED"
  | "NAN_UNSUPPORTED_MODEL"
  | "NAN_UNSUPPORTED_CAPABILITY"
  | "NAN_MALFORMED_RESPONSE"
  | "NAN_INPUT_TOO_LARGE";

const ERROR_MESSAGES: Record<AgentErrorCode, string> = {
  AGENT_TOKEN_MISSING: "A short-lived connection token is required.",
  AGENT_NOT_CONFIGURED: "The agent runtime is not configured for this deployment.",
  AGENT_VERIFY_UNAVAILABLE: "Identity verification is temporarily unavailable; try again.",
  AGENT_VERIFY_FAILED: "Identity verification failed; the connection was refused.",
  AGENT_SCOPE_MISMATCH: "This agent instance does not match the verified owner and project.",
  AGENT_UNAUTHENTICATED: "This connection has no verified session.",
  AGENT_SESSION_EXPIRED: "The agent session expired; request a new connection token and reconnect.",
  AGENT_SESSION_INVALID: "The agent session is no longer valid; reconnect with a new connection token.",
  AGENT_SESSION_FORGED: "The agent session failed its integrity check.",
  AGENT_BAD_MESSAGE: "The agent does not understand that message.",
  AGENT_NOT_FOUND: "No agent route matches this path.",
  AGENT_QUOTA_EXCEEDED:
    "Cloudflare Workers Free plan quota reached for the agent runtime; the operation was refused. This deployment never upgrades to a paid plan automatically.",
  AGENT_INTERNAL: "The agent runtime hit an internal error.",
  CONNECTION_TOKEN_INVALID: "The connection token is not valid.",
  CONNECTION_TOKEN_EXPIRED: "The connection token has expired; issue a new token and reconnect.",
  CONNECTION_TOKEN_REVOKED: "The connection token was revoked or already rotated.",
  CONNECTION_TOKEN_SCOPE: "The connection token does not grant access to this project.",
  NAN_PROVIDER_ERROR: "The NaN provider request failed.",
  NAN_POLICY_BLOCKED: "NaN provider policy blocked this request; only the deployer's own key may be used.",
  NAN_RATE_LIMITED: "The NaN provider rate limit was reached.",
  NAN_TIMEOUT: "The NaN provider request timed out.",
  NAN_CANCELLED: "The NaN provider request was cancelled.",
  NAN_UNSUPPORTED_MODEL: "The configured NaN model rejected the request.",
  NAN_UNSUPPORTED_CAPABILITY: "The NaN provider does not support this capability.",
  NAN_MALFORMED_RESPONSE: "The NaN provider returned a malformed response.",
  NAN_INPUT_TOO_LARGE: "The input exceeds the configured NaN limit.",
};

export class AgentError extends Error {
  public constructor(
    public readonly code: AgentErrorCode,
    message: string = ERROR_MESSAGES[code],
    public readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export function agentErrorMessage(code: AgentErrorCode): string {
  return ERROR_MESSAGES[code];
}

export function isAgentErrorCode(value: unknown): value is AgentErrorCode {
  return typeof value === "string" && value in ERROR_MESSAGES;
}

export function agentErrorFromUnknown(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (isAgentErrorCode(code)) {
    const status = code === "CONNECTION_TOKEN_SCOPE" || code === "AGENT_SCOPE_MISMATCH" ? 403 : 401;
    if (code.startsWith("CONNECTION_TOKEN_") || code.startsWith("AGENT_")) {
      return new AgentError(code, ERROR_MESSAGES[code], status);
    }
    return new AgentError(code, ERROR_MESSAGES[code], 502);
  }
  return new AgentError("AGENT_INTERNAL", ERROR_MESSAGES.AGENT_INTERNAL, 500);
}

export function jsonError(code: AgentErrorCode, message = agentErrorMessage(code), status?: number): Response {
  return new Response(JSON.stringify({ code, message }), {
    status: status ?? (code.startsWith("CONNECTION_TOKEN_SCOPE") || code === "AGENT_SCOPE_MISMATCH" ? 403 : 400),
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
}
