/**
 * Client for the S06 Convex connection-token contract
 * (packages/api/convex/agentSessions.ts + http.ts). Cloudflare does not accept
 * Convex Auth JWTs implicitly, so every agent handshake presents the
 * short-lived, owner+project-scoped server-issued connection token and the
 * Convex deployment is the authority that verifies it.
 */
export type ConvexVerifySuccess = {
  ok: true;
  tokenId: string;
  ownerId: string;
  projectId: string;
  issuedAt: number;
  expiresAt: number;
  verifyCount: number;
  rotated: boolean;
  /** Present only when this call rotated (reconnect) the token. */
  token?: string;
};

export type ConvexVerifyFailure = {
  ok: false;
  code: string;
  httpStatus: number;
};

export type ConvexVerifyResult = ConvexVerifySuccess | ConvexVerifyFailure;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type VerifyOptions = {
  /** Rotates the presented token through `/agent/connection-tokens/reconnect`. */
  reconnect?: boolean;
  fetchImpl?: FetchLike;
};

const FAILURE_STATUS_BY_CODE: Record<string, number> = {
  CONNECTION_TOKEN_SCOPE: 403,
  INVALID_BODY: 400,
};

function failure(code: string, httpStatus?: number): ConvexVerifyFailure {
  return { ok: false, code, httpStatus: httpStatus ?? FAILURE_STATUS_BY_CODE[code] ?? 401 };
}

function normalizeBaseUrl(convexUrl: string): string | null {
  const trimmed = convexUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Verifies (or, with `reconnect`, revalidates-and-rotates) a presented
 * connection token against the Convex deployment. Never throws for expected
 * outcomes: forged, expired, revoked/replayed and out-of-scope tokens are
 * returned as typed failures, and configuration/network problems fail closed.
 */
export async function verifyAgentConnectionToken(
  convexUrl: string,
  token: string,
  options: VerifyOptions = {},
): Promise<ConvexVerifyResult> {
  const base = normalizeBaseUrl(convexUrl);
  if (base === null) return failure("AGENT_NOT_CONFIGURED", 503);
  if (token.length === 0) return failure("AGENT_TOKEN_MISSING", 401);
  const path = options.reconnect ? "/agent/connection-tokens/reconnect" : "/agent/connection-tokens/verify";
  const fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    return failure("AGENT_VERIFY_UNAVAILABLE", 502);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure("AGENT_VERIFY_UNAVAILABLE", 502);
  }
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  if (
    response.ok &&
    record !== null &&
    record.ok === true &&
    typeof record.ownerId === "string" &&
    typeof record.projectId === "string" &&
    typeof record.expiresAt === "number" &&
    typeof record.tokenId === "string" &&
    typeof record.issuedAt === "number" &&
    typeof record.verifyCount === "number" &&
    typeof record.rotated === "boolean"
  ) {
    const success: ConvexVerifySuccess = {
      ok: true,
      tokenId: record.tokenId,
      ownerId: record.ownerId,
      projectId: record.projectId,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      verifyCount: record.verifyCount,
      rotated: record.rotated,
    };
    if (typeof record.token === "string") success.token = record.token;
    if (success.rotated && typeof success.token !== "string") return failure("AGENT_VERIFY_FAILED", 502);
    if (Date.now() >= success.expiresAt) return failure("CONNECTION_TOKEN_EXPIRED", 401);
    return success;
  }
  const code = typeof record?.code === "string" ? record.code : "AGENT_VERIFY_FAILED";
  const httpStatus =
    typeof record?.code === "string"
      ? response.status >= 400 && response.status < 600
        ? response.status
        : (FAILURE_STATUS_BY_CODE[code] ?? 401)
      : 502;
  return failure(code, httpStatus);
}
