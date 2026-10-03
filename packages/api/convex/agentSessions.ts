import { getAuthSessionId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
import { requireOwnedProject, requireUserId } from "./projects";

/**
 * S06 verified agent-session contract that S07 consumes.
 *
 * A connection token is a short-lived, high-entropy secret bound to
 * `ownerId + projectId` (never to an email address or a bare user id). Only its
 * SHA-256 hash is stored, so possession of the token is the agent handshake
 * credential: issue it in the browser, present it at the agent entry point, and
 * revalidate it on every reconnect. Cloudflare hosting itself is S07; the
 * transport here is this repository's Convex HTTP routes.
 */
export const CONNECTION_TOKEN_DEFAULT_TTL_SECONDS = 300;
export const CONNECTION_TOKEN_MAX_TTL_SECONDS = 900;
const CONNECTION_TOKEN_BYTES = 32;
const CLEANUP_BATCH = 25;
const REVOKE_BATCH = 100;

export type ConnectionTokenStatus = "valid" | "forged" | "revoked" | "expired" | "scope";

export type ConnectionTokenSnapshot = {
  ownerId: string;
  projectId: string;
  tokenHash: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
};

export type ConnectionTokenEvaluation = {
  presentedHash: string;
  record: ConnectionTokenSnapshot | null;
  project: { ownerId: string; deletedAt: number | null } | null;
  callerOwnerId: string | null;
  now: number;
};

/**
 * Pure decision used by every verification path. Precedence: a token that does
 * not match a stored hash is forged, a revoked (rotated or signed-out) token is
 * rejected as a replay, then expiry, then scope (caller ownership and a live,
 * unchanged project). Nothing is accepted on expiry or scope alone.
 */
export function evaluateConnectionToken(evaluation: ConnectionTokenEvaluation): ConnectionTokenStatus {
  const { record } = evaluation;
  if (record === null || record.tokenHash !== evaluation.presentedHash) return "forged";
  if (record.revokedAt !== null) return "revoked";
  if (evaluation.now >= record.expiresAt) return "expired";
  if (evaluation.callerOwnerId !== null && evaluation.callerOwnerId !== record.ownerId) return "scope";
  if (evaluation.project === null || evaluation.project.ownerId !== record.ownerId || evaluation.project.deletedAt !== null) return "scope";
  return "valid";
}

export function connectionTokenErrorCode(status: ConnectionTokenStatus): string {
  switch (status) {
    case "forged":
      return "CONNECTION_TOKEN_INVALID";
    case "revoked":
      return "CONNECTION_TOKEN_REVOKED";
    case "expired":
      return "CONNECTION_TOKEN_EXPIRED";
    case "scope":
      return "CONNECTION_TOKEN_SCOPE";
    default:
      return "CONNECTION_TOKEN_INVALID";
  }
}

function connectionTokenError(status: ConnectionTokenStatus): ConvexError<{ code: string }> {
  return new ConvexError({ code: connectionTokenErrorCode(status) });
}

function normalizeTtlSeconds(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined) return CONNECTION_TOKEN_DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > CONNECTION_TOKEN_MAX_TTL_SECONDS) throw new ConvexError({ code: "INVALID_ARGUMENT" });
  return ttlSeconds;
}

function randomConnectionToken(): string {
  const bytes = new Uint8Array(CONNECTION_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let token = "";
  for (const byte of bytes) token += byte.toString(16).padStart(2, "0");
  return token;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Bounded cleanup so issued tokens cannot accumulate past their TTL. */
async function cleanupExpiredTokens(ctx: MutationCtx, ownerId: string, projectId: Id<"projects">): Promise<void> {
  const now = Date.now();
  const tokens = await ctx.db.query("agentConnectionTokens").withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId)).take(CLEANUP_BATCH);
  for (const token of tokens) {
    if (token.expiresAt <= now) await ctx.db.delete(token._id);
  }
}

async function resolveConnectionToken(ctx: MutationCtx, presentedToken: string, callerOwnerId: string | null) {
  const presentedHash = await sha256Hex(presentedToken);
  const matches = await ctx.db.query("agentConnectionTokens").withIndex("by_token_hash", (q) => q.eq("tokenHash", presentedHash)).take(2);
  const record = matches.length === 1 ? matches[0] : null;
  const project = record === null ? null : await ctx.db.get(record.projectId);
  const status = evaluateConnectionToken({ presentedHash, record, project, callerOwnerId, now: Date.now() });
  return { record, status };
}

const connectionTokenResult = v.object({
  tokenId: v.id("agentConnectionTokens"),
  ownerId: v.string(),
  projectId: v.id("projects"),
  issuedAt: v.number(),
  expiresAt: v.number(),
  verifyCount: v.number(),
  rotated: v.boolean(),
  token: v.optional(v.string()),
});

type ConnectionTokenResult = {
  tokenId: Id<"agentConnectionTokens">;
  ownerId: string;
  projectId: Id<"projects">;
  issuedAt: number;
  expiresAt: number;
  verifyCount: number;
  rotated: boolean;
  token?: string;
};

async function verifyAndMaybeRotate(ctx: MutationCtx, args: { token: string; rotate: boolean; ttlSeconds?: number | undefined }, callerOwnerId: string | null): Promise<ConnectionTokenResult> {
  const { record, status } = await resolveConnectionToken(ctx, args.token, callerOwnerId);
  if (record === null || status !== "valid") throw connectionTokenError(status);
  const now = Date.now();
  const verifyCount = record.verifyCount + 1;
  await ctx.db.patch(record._id, { verifyCount, lastVerifiedAt: now });
  if (!args.rotate) return { tokenId: record._id, ownerId: record.ownerId, projectId: record.projectId, issuedAt: record.issuedAt, expiresAt: record.expiresAt, verifyCount, rotated: false };
  const ttlSeconds = normalizeTtlSeconds(args.ttlSeconds);
  const token = randomConnectionToken();
  const tokenHash = await sha256Hex(token);
  const issuedAt = now;
  const expiresAt = now + ttlSeconds * 1000;
  const tokenId = await ctx.db.insert("agentConnectionTokens", { ownerId: record.ownerId, projectId: record.projectId, tokenHash, issuedAt, expiresAt, revokedAt: null, lastVerifiedAt: null, verifyCount: 0, authSessionId: record.authSessionId });
  await ctx.db.patch(record._id, { revokedAt: now, replacedBy: tokenId });
  return { tokenId, ownerId: record.ownerId, projectId: record.projectId, issuedAt, expiresAt, verifyCount: 0, rotated: true, token };
}

/** Issues a scoped connection token for an owned project; the plaintext is returned once. */
export const issueConnectionToken = mutation({
  args: { projectId: v.id("projects"), ttlSeconds: v.optional(v.number()) },
  returns: v.object({ tokenId: v.id("agentConnectionTokens"), token: v.string(), issuedAt: v.number(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const authSessionId = await getAuthSessionId(ctx);
    // No email-only and no user-id-only binding: a connection token may only be
    // issued from a full Convex Auth session subject (`userId|sessionId`). An
    // identity that carries only an email address, only a user id, or a half of
    // that subject is rejected here, so no stored record can ever be bound to a
    // partial identity.
    if (ownerId.length === 0 || typeof authSessionId !== "string" || authSessionId.length === 0) throw new ConvexError({ code: "UNAUTHENTICATED" });
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const ttlSeconds = normalizeTtlSeconds(args.ttlSeconds);
    await cleanupExpiredTokens(ctx, ownerId, args.projectId);
    const token = randomConnectionToken();
    const tokenHash = await sha256Hex(token);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + ttlSeconds * 1000;
    const tokenId = await ctx.db.insert("agentConnectionTokens", { ownerId, projectId: args.projectId, tokenHash, issuedAt, expiresAt, revokedAt: null, lastVerifiedAt: null, verifyCount: 0, authSessionId });
    return { tokenId, token, issuedAt, expiresAt };
  },
});

/** Revokes one token the caller owns; a replay after revocation is rejected. */
export const revokeConnectionToken = mutation({
  args: { tokenId: v.id("agentConnectionTokens") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db.get(args.tokenId);
    if (record === null || record.ownerId !== ownerId) throw new ConvexError({ code: "NOT_FOUND" });
    if (record.revokedAt === null) await ctx.db.patch(args.tokenId, { revokedAt: Date.now() });
    return null;
  },
});

/**
 * Revokes every token of the signed-in owner in one bounded batch. The client
 * calls this before Convex Auth `signOut` so an agent cannot keep using a
 * connection token after sign-out.
 */
export const revokeAllConnectionTokens = mutation({
  args: {},
  returns: v.object({ revoked: v.number(), remaining: v.boolean() }),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const now = Date.now();
    const tokens = await ctx.db.query("agentConnectionTokens").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).take(REVOKE_BATCH);
    let revoked = 0;
    for (const token of tokens) {
      if (token.revokedAt === null) {
        await ctx.db.patch(token._id, { revokedAt: now });
        revoked += 1;
      }
    }
    return { revoked, remaining: tokens.length === REVOKE_BATCH };
  },
});

/**
 * Authenticated revalidation used when the signed-in owner re-checks a token
 * (for example before handing it to a reconnecting agent). The caller must own
 * the token: a different signed-in user is rejected as a scope violation.
 */
export const revalidateConnectionToken = mutation({
  args: { token: v.string(), rotate: v.boolean(), ttlSeconds: v.optional(v.number()) },
  returns: connectionTokenResult,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    return verifyAndMaybeRotate(ctx, args, ownerId);
  },
});

/**
 * Agent handshake entry (S07): verifies a presented token without trusting any
 * client-supplied user id. `rotate` revalidates on reconnect by revoking the
 * presented token and issuing its replacement, so a replayed old token fails.
 */
export const verifyConnectionToken = internalMutation({
  args: { token: v.string(), rotate: v.boolean(), ttlSeconds: v.optional(v.number()) },
  returns: connectionTokenResult,
  handler: async (ctx, args) => verifyAndMaybeRotate(ctx, args, null),
});
