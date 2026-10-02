import { verifyAgentConnectionToken, type ConvexVerifyFailure, type FetchLike } from "./convexClient.js";
import { agentErrorMessage, isAgentErrorCode, jsonError, type AgentErrorCode } from "./errors.js";
import { AGENT_SESSION_HEADER, SESSION_TOKEN_QUERY_PARAM, deriveInstanceId, signBridgeSession } from "./scope.js";

/**
 * Pre-connection / pre-request gate for every route that reaches the agent
 * Durable Object. It runs inside the Worker before any Durable Object is
 * touched and validates the S06 Convex connection token end to end:
 *
 * 1. present a token (query parameter for WebSocket upgrades, Bearer header
 *    for HTTP), 2. verify it against the Convex deployment (identity + live
 *    owner+project scope), 3. derive the owner-scoped instance id and require
 *    it to equal the requested instance name, then 4. forward a request whose
 *    client-supplied bridge/authorization headers were stripped and replaced
 *    with a signed, short-lived bridge session for the Durable Object.
 *
 * Any failure returns an HTTP error response; the Durable Object is never
 * created or reached for that request.
 */
export type GateEnv = {
  CONVEX_URL?: string;
  AGENT_BRIDGE_SECRET?: string;
};

export type GateRoute = {
  name: string;
};

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  const match = /^Bearer[ ]+(.*)$/i.exec(authorization.trim());
  return match === null ? null : match[1].trim();
}

function verifyFailureResponse(failure: ConvexVerifyFailure): Response {
  const code: AgentErrorCode = isAgentErrorCode(failure.code) ? failure.code : "AGENT_VERIFY_FAILED";
  const status =
    code === "AGENT_NOT_CONFIGURED"
      ? 503
      : failure.httpStatus >= 500
        ? 502
        : failure.httpStatus >= 400
          ? failure.httpStatus
          : 401;
  return jsonError(code, agentErrorMessage(code), status);
}

export async function gateAgentRequest(
  request: Request,
  env: GateEnv,
  route: GateRoute,
  fetchImpl?: FetchLike,
): Promise<Request | Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError("AGENT_BAD_MESSAGE", "The agent accepts WebSocket upgrades and GET requests only.", 405);
  }
  const secret = env.AGENT_BRIDGE_SECRET ?? "";
  if (secret.length === 0) {
    return jsonError("AGENT_NOT_CONFIGURED", agentErrorMessage("AGENT_NOT_CONFIGURED"), 503);
  }
  const url = new URL(request.url);
  const token = url.searchParams.get(SESSION_TOKEN_QUERY_PARAM) ?? bearerToken(request) ?? "";
  if (token.length === 0) return jsonError("AGENT_TOKEN_MISSING", agentErrorMessage("AGENT_TOKEN_MISSING"), 401);

  const verified = await verifyAgentConnectionToken(env.CONVEX_URL ?? "", token, { fetchImpl });
  if (!verified.ok) return verifyFailureResponse(verified);

  const instanceId = await deriveInstanceId(secret, verified.ownerId, verified.projectId);
  if (instanceId !== route.name) {
    return jsonError("AGENT_SCOPE_MISMATCH", agentErrorMessage("AGENT_SCOPE_MISMATCH"), 403);
  }

  const headers = new Headers(request.headers);
  headers.delete(AGENT_SESSION_HEADER);
  headers.delete("authorization");
  url.searchParams.delete(SESSION_TOKEN_QUERY_PARAM);
  headers.set(
    AGENT_SESSION_HEADER,
    await signBridgeSession(secret, {
      token,
      ownerId: verified.ownerId,
      projectId: verified.projectId,
      instanceId,
      verifiedAt: Date.now(),
      expiresAt: verified.expiresAt,
    }),
  );

  const init: RequestInit = { method: request.method, headers, redirect: "manual" };
  return new Request(url.toString(), init);
}
