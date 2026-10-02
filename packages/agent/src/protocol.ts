import { agentErrorMessage, type AgentErrorCode } from "./errors.js";

/** Upper bound for one inbound WebSocket message; larger payloads are refused. */
export const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
const MAX_TURN_ID_LENGTH = 128;
/** NaN input cap matches the S11 adapter default so oversized turns fail early. */
export const MAX_TURN_TEXT_CHARACTERS = 24_000;

export type ClientMessage = { type: "ping" } | { type: "state.read" } | { type: "tutor.turn"; turnId: string; text: string };

export type ServerMessage =
  | { type: "session"; instanceId: string; ownerId: string; projectId: string; expiresAt: number }
  | { type: "pong"; serverTime: number }
  | { type: "state.read.result"; instanceId: string; ownerId: string; projectId: string; expiresAt: number; connections: number }
  | { type: "tutor.turn.result"; turnId: string; reply: string }
  | { type: "error"; code: AgentErrorCode; message: string };

export function errorMessage(code: AgentErrorCode, message = agentErrorMessage(code)): ServerMessage {
  return { type: "error", code, message };
}

/** Control frames (`cf_*`) belong to the Agents SDK itself and are not ours. */
export function isSdkControlFrame(raw: string): boolean {
  if (!raw.includes("cf_")) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    const type = (parsed as { type?: unknown } | null)?.type;
    return typeof type === "string" && type.startsWith("cf_");
  } catch {
    return false;
  }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length === 0 || raw.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message.type === "ping") return { type: "ping" };
  if (message.type === "state.read") return { type: "state.read" };
  if (message.type === "tutor.turn") {
    if (typeof message.turnId !== "string" || message.turnId.length === 0 || message.turnId.length > MAX_TURN_ID_LENGTH) return null;
    if (typeof message.text !== "string" || message.text.length === 0 || message.text.length > MAX_TURN_TEXT_CHARACTERS) return null;
    return { type: "tutor.turn", turnId: message.turnId, text: message.text };
  }
  return null;
}
