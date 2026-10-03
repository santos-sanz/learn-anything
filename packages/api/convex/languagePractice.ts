import { MAX_PRACTISED_TOPIC_CHARS, validateLanguagePracticeConfig } from "@learn-anything/worker";
import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireOwnedProject, requireUserId } from "./projects";

/**
 * S19 language-practice mode configuration and practised-topic history.
 *
 * - `updateLanguagePracticeConfig` is the owner-only write for the project's
 *   language-practice settings (target language, level, correction style,
 *   goals, roleplay scenarios). Identity comes only from `ctx.auth`; the
 *   payload is re-validated by the S19 worker contract, so enum values and
 *   list bounds cannot drift from the prompt contract.
 * - `recordPractisedTopic` is an internal server-caller mutation invoked by
 *   the S14 turn action after a completed language-practice turn. It is
 *   idempotent per (owner, project, turnId), so a replayed turn never
 *   duplicates history.
 * - History records topics, never judgements: no stored or returned field
 *   claims certified proficiency, a achieved level or pronunciation accuracy.
 */

export const languagePracticeConfigValidator = v.object({
  targetLanguage: v.union(v.literal("en"), v.literal("es")),
  level: v.union(v.literal("beginner"), v.literal("intermediate"), v.literal("advanced")),
  correctionStyle: v.union(v.literal("immediate"), v.literal("end-of-turn")),
  goals: v.array(v.string()),
  roleplayScenarios: v.array(v.string()),
});

const practisedTopicValidator = v.object({
  _id: v.id("practisedTopics"),
  turnId: v.string(),
  topic: v.string(),
  level: v.union(v.literal("beginner"), v.literal("intermediate"), v.literal("advanced")),
  targetLanguage: v.union(v.literal("en"), v.literal("es")),
  createdAt: v.number(),
});

function requireTopic(value: string): string {
  const topic = value.trim();
  if (topic === "" || topic.length > MAX_PRACTISED_TOPIC_CHARS) throw new ConvexError({ code: "INVALID_ARGUMENT" });
  return topic;
}

async function loadPractisedTopic(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  projectId: Id<"projects">,
  turnId: string,
) {
  return await ctx.db
    .query("practisedTopics")
    .withIndex("by_owner_project_turn", (q) => q.eq("ownerId", ownerId).eq("projectId", projectId).eq("turnId", turnId))
    .unique();
}

/**
 * Creates or replaces the project's language-practice configuration. A `null`
 * config clears it (the project keeps its mode, but the tutor falls back to
 * the plain S14 prompt until it is configured again). Ownership is re-derived
 * from `ctx.auth`; an anonymous or foreign caller is a non-enumerating error.
 */
export const updateLanguagePracticeConfig = mutation({
  args: { projectId: v.id("projects"), config: v.union(v.null(), languagePracticeConfigValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    if (args.config === null) {
      await ctx.db.patch(args.projectId, { languagePractice: undefined });
      return null;
    }
    const validated = validateLanguagePracticeConfig(args.config);
    if (!validated.ok) throw new ConvexError({ code: "INVALID_ARGUMENT", reason: validated.reason });
    await ctx.db.patch(args.projectId, {
      languagePractice: {
        targetLanguage: validated.config.targetLanguage,
        level: validated.config.level,
        correctionStyle: validated.config.correctionStyle,
        goals: [...validated.config.goals],
        roleplayScenarios: [...validated.config.roleplayScenarios],
      },
    });
    return null;
  },
});

/** Owner-only read of the stored configuration; `null` means unconfigured. */
export const getLanguagePracticeConfig = query({
  args: { projectId: v.id("projects") },
  returns: v.union(v.null(), languagePracticeConfigValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const project = await requireOwnedProject(ctx, ownerId, args.projectId);
    return project.languagePractice ?? null;
  },
});

/**
 * Records one practised topic for a completed language-practice turn.
 * Idempotent per turn: a replay returns the existing row instead of writing a
 * second one. The stored fields are the topic and the learner-selected
 * settings at practice time - there is no score, proficiency or pronunciation
 * field to record, by contract.
 */
export const recordPractisedTopic = internalMutation({
  args: {
    ownerId: v.string(),
    projectId: v.id("projects"),
    sessionId: v.id("learningSessions"),
    turnId: v.string(),
    topic: v.string(),
    level: v.union(v.literal("beginner"), v.literal("intermediate"), v.literal("advanced")),
    targetLanguage: v.union(v.literal("en"), v.literal("es")),
  },
  returns: v.id("practisedTopics"),
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, args.ownerId, args.projectId);
    const session = await ctx.db.get(args.sessionId);
    if (session === null || session.ownerId !== args.ownerId || session.projectId !== args.projectId) {
      throw new ConvexError({ code: "NOT_FOUND" });
    }
    const existing = await loadPractisedTopic(ctx, args.ownerId, args.projectId, args.turnId);
    if (existing !== null) return existing._id;
    return await ctx.db.insert("practisedTopics", {
      ownerId: args.ownerId,
      projectId: args.projectId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      topic: requireTopic(args.topic),
      level: args.level,
      targetLanguage: args.targetLanguage,
      createdAt: Date.now(),
    });
  },
});

/**
 * Owner-only practice history, newest first and bounded. The returned shape
 * is exactly `{ topic, level, targetLanguage, ... }`: no proficiency claim,
 * no certificate, no score and no pronunciation field exists on this surface.
 */
export const listPractisedTopics = query({
  args: { projectId: v.id("projects"), limit: v.optional(v.number()) },
  returns: v.object({ topics: v.array(practisedTopicValidator) }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await requireOwnedProject(ctx, ownerId, args.projectId);
    const limit = args.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ConvexError({ code: "INVALID_ARGUMENT" });
    const rows = await ctx.db
      .query("practisedTopics")
      .withIndex("by_owner_project", (q) => q.eq("ownerId", ownerId).eq("projectId", args.projectId))
      .order("desc")
      .take(limit);
    return {
      topics: rows.map((row) => ({
        _id: row._id,
        turnId: row.turnId,
        topic: row.topic,
        level: row.level,
        targetLanguage: row.targetLanguage,
        createdAt: row.createdAt,
      })),
    };
  },
});
