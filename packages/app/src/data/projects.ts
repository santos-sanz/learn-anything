import { api } from "@learn-anything/api/convex/_generated/api";
import type { Id } from "@learn-anything/api/convex/_generated/dataModel";
import type { ConvexReactClient } from "convex/react";

/** The two learner tracks selectable in S21; S19/S20 implement the tutor behaviour. */
export type LearningMode = "language-practice" | "concept-learning";

export const LEARNING_MODES: readonly LearningMode[] = ["language-practice", "concept-learning"];

export type ProjectSummary = {
  id: string;
  name: string;
  goal?: string;
  mode?: LearningMode;
  createdAt: number;
};

/** What the create form submits: an empty goal is dropped before the call. */
export type ProjectDraft = { name: string; goal?: string; mode?: LearningMode };

/**
 * What the edit form submits: `goal` is always a string where "" clears the
 * stored selection; `mode` is omitted when no track is selected (an existing
 * selection cannot be cleared from the UI yet).
 */
export type ProjectPatch = { name: string; goal: string; mode?: LearningMode };

export type ProjectsBackend = {
  list(): Promise<ProjectSummary[]>;
  get(id: string): Promise<ProjectSummary>;
  create(draft: ProjectDraft): Promise<string>;
  update(id: string, patch: ProjectPatch): Promise<void>;
  remove(id: string): Promise<void>;
};

type ConvexClient = Pick<ConvexReactClient, "query" | "mutation">;

const asProjectId = (id: string) => id as Id<"projects">;

type ProjectRow = { _id: Id<"projects">; name: string; goal?: string; mode?: LearningMode; createdAt: number };

const toSummary = (row: ProjectRow): ProjectSummary => ({ id: row._id, name: row.name, goal: row.goal, mode: row.mode, createdAt: row.createdAt });

/** Bounded so a stuck batch loop fails visibly instead of running forever. */
const DELETE_BATCH_LIMIT = 100;
const DELETE_MAX_BATCHES = 500;

/**
 * The production data port: every call goes through authorized Convex
 * functions; identity and ownership are re-derived server-side (S05/S06).
 * Deletion drives the two-phase S04 protocol (soft-delete, then bounded
 * batches) so large projects are removed without an unbounded mutation.
 */
export function makeConvexProjectsBackend(client: ConvexClient): ProjectsBackend {
  return {
    async list() {
      const projects = await client.query(api.projects.listProjects, {});
      return projects.map(toSummary);
    },
    async get(id) {
      return toSummary(await client.query(api.projects.getProject, { projectId: asProjectId(id) }));
    },
    async create(draft) {
      const goal = draft.goal === undefined || draft.goal.trim() === "" ? undefined : draft.goal.trim();
      const id = await client.mutation(api.projects.createProject, { name: draft.name, goal, mode: draft.mode });
      return id as string;
    },
    async update(id, patch) {
      await client.mutation(api.projects.updateProject, { projectId: asProjectId(id), name: patch.name, goal: patch.goal, mode: patch.mode });
    },
    async remove(id) {
      const projectId = asProjectId(id);
      await client.mutation(api.projects.requestProjectDeletion, { projectId });
      for (let attempt = 0; attempt < DELETE_MAX_BATCHES; attempt += 1) {
        const batch = await client.mutation(api.projects.deleteProjectBatch, { projectId, limit: DELETE_BATCH_LIMIT });
        if (batch.completed) return;
      }
      throw new Error("Project deletion did not finish; retry from the dashboard.");
    },
  };
}
