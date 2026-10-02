import { verifyAgentConnectionToken, type FetchLike } from "./convexClient.js";
import { agentErrorMessage, isAgentErrorCode, jsonError, type AgentErrorCode } from "./errors.js";
import type { GateEnv } from "./gate.js";
import { agentConnectPath } from "./routes.js";
import { deriveInstanceId } from "./scope.js";

/**
 * `POST /agent/session` — the discovery step of the S07 handshake. The client
 * (already authenticated in Convex) presents its short-lived connection token;
 * this endpoint verifies it against Convex, derives the owner-scoped unguessable
 * instance id and returns the path to connect to. With `reconnect: true` it
 * revalidates through `/agent/connection-tokens/reconnect`, which rotates the
 * token so the presented one becomes a rejected replay from that moment on.
 */
export type SessionRequest = { token: string; reconnect?: boolean };

function verifyFailureResponse(code: string, status: number): Response {
  const mapped: AgentErrorCode = isAgentErrorCode(code) ? code : "AGENT_VERIFY_FAILED";
  const mappedStatus = mapped === "AGENT_NOT_CONFIGURED" ? 503 : status >= 500 ? 502 : status >= 400 ? status : 401;
  return jsonError(mapped, agentErrorMessage(mapped), mappedStatus);
}

export async function handleSessionRequest(
  request: Request,
  env: GateEnv,
  fetchImpl?: FetchLike,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("AGENT_BAD_MESSAGE", "Use POST with a JSON body { token, reconnect? }.", 405);
  }
  const secret = env.AGENT_BRIDGE_SECRET ?? "";
  if (secret.length === 0) {
    return jsonError("AGENT_NOT_CONFIGURED", agentErrorMessage("AGENT_NOT_CONFIGURED"), 503);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("AGENT_BAD_MESSAGE", "Request body must be JSON.", 400);
  }
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  const token = record?.token;
  const reconnect = record?.reconnect;
  if (typeof token !== "string" || token.length === 0 || (reconnect !== undefined && typeof reconnect !== "boolean")) {
    return jsonError("AGENT_BAD_MESSAGE", "Request body must be JSON with a non-empty token and optional boolean reconnect.", 400);
  }

  const verified = await verifyAgentConnectionToken(env.CONVEX_URL ?? "", token, { reconnect: reconnect === true, fetchImpl });
  if (!verified.ok) return verifyFailureResponse(verified.code, verified.httpStatus);

  const instanceId = await deriveInstanceId(secret, verified.ownerId, verified.projectId);
  const payload: Record<string, unknown> = {
    ok: true,
    instanceId,
    connectPath: agentConnectPath(instanceId),
    expiresAt: verified.expiresAt,
    rotated: verified.rotated,
  };
  if (verified.rotated && typeof verified.token === "string") payload.token = verified.token;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
}
