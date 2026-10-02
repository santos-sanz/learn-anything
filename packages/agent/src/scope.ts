import { base64UrlDecode, base64UrlEncode, toHex, utf8Bytes, utf8String } from "./encoding.js";
import { AgentError } from "./errors.js";

/**
 * Owner-scoped, unguessable agent instance identifiers and the signed
 * Worker-to-Durable-Object session header.
 *
 * An instance id is `la_ + HMAC-SHA256(AGENT_BRIDGE_SECRET, ownerId +
 * projectId)[:32]`. Without the deployment secret nobody can derive or guess
 * another owner's instance id, and the same owner+project always resolves to
 * the same Durable Object, so reconnects reach the same scoped instance. The
 * id itself never embeds the owner id, project id, conversation id or any
 * other readable identifier.
 */
export const INSTANCE_ID_PREFIX = "la_";
export const AGENT_SESSION_HEADER = "x-agent-session";
export const SESSION_TOKEN_QUERY_PARAM = "token";

export type BridgeSession = {
  token: string;
  ownerId: string;
  projectId: string;
  instanceId: string;
  verifiedAt: number;
  expiresAt: number;
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length === 0) throw new AgentError("AGENT_NOT_CONFIGURED", "The agent runtime is not configured for this deployment.", 503);
  return crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  const digest = await crypto.subtle.sign("HMAC", key, utf8Bytes(message));
  return toHex(new Uint8Array(digest));
}

async function hmacVerify(secret: string, message: string, signatureHex: string): Promise<boolean> {
  const key = await hmacKey(secret);
  const bytes = new Uint8Array(signatureHex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = signatureHex.slice(index * 2, index * 2 + 2);
    if (!/^[0-9a-f]{2}$/.test(pair)) return false;
    bytes[index] = Number.parseInt(pair, 16);
  }
  return crypto.subtle.verify("HMAC", key, bytes, utf8Bytes(message));
}

export async function deriveInstanceId(secret: string, ownerId: string, projectId: string): Promise<string> {
  const signature = await hmacSign(secret, `${ownerId}\n${projectId}`);
  return `${INSTANCE_ID_PREFIX}${signature.slice(0, 32)}`;
}

function bridgePayloadMessage(session: BridgeSession): string {
  return `${session.token}\n${session.ownerId}\n${session.projectId}\n${session.instanceId}\n${session.verifiedAt}\n${session.expiresAt}`;
}

export async function signBridgeSession(secret: string, session: BridgeSession): Promise<string> {
  const body = base64UrlEncode(utf8Bytes(JSON.stringify(session)));
  const signature = await hmacSign(secret, bridgePayloadMessage(session));
  return `${body}.${signature}`;
}

/** Parses and signature-checks a bridge header; returns null on any tampering. */
export async function parseBridgeSession(secret: string, headerValue: string | null): Promise<BridgeSession | null> {
  if (!headerValue) return null;
  const separator = headerValue.lastIndexOf(".");
  if (separator <= 0) return null;
  const body = headerValue.slice(0, separator);
  const signature = headerValue.slice(separator + 1);
  let session: BridgeSession;
  try {
    const parsed: unknown = JSON.parse(utf8String(base64UrlDecode(body)));
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Partial<BridgeSession>;
    if (
      typeof candidate.token !== "string" ||
      typeof candidate.ownerId !== "string" ||
      typeof candidate.projectId !== "string" ||
      typeof candidate.instanceId !== "string" ||
      typeof candidate.verifiedAt !== "number" ||
      typeof candidate.expiresAt !== "number"
    ) {
      return null;
    }
    session = candidate as BridgeSession;
  } catch {
    return null;
  }
  const valid = await hmacVerify(secret, bridgePayloadMessage(session), signature);
  if (!valid) return null;
  return session;
}

/**
 * Validates a parsed bridge session against the deployment secret and this
 * Durable Object's instance identity (when the runtime exposes the name),
 * plus the wall clock. Throws a visible AgentError instead of returning a
 * boolean so callers surface the reason.
 */
export async function assertUsableBridgeSession(secret: string, instanceName: string | undefined, session: BridgeSession): Promise<void> {
  const expectedInstanceId = await deriveInstanceId(secret, session.ownerId, session.projectId);
  if (expectedInstanceId !== session.instanceId || (instanceName !== undefined && session.instanceId !== instanceName)) {
    throw new AgentError("AGENT_SCOPE_MISMATCH", undefined, 403);
  }
  if (Date.now() >= session.expiresAt) {
    throw new AgentError("AGENT_SESSION_EXPIRED", undefined, 401);
  }
}
