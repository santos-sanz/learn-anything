import type { ConvexReactClient } from "convex/react";

import type { ProjectDraft, ProjectPatch, ProjectSummary, ProjectsBackend } from "../src/data/projects.js";

export type ListMode = "ok" | "error" | "pending";

export type FixtureState = {
  projects: ProjectSummary[];
  listMode: ListMode;
  listCalls: number;
  created: ProjectDraft[];
  updated: { id: string; patch: ProjectPatch }[];
  removed: string[];
  /** Ids that took the soft-delete step but whose cleanup never finished. */
  softDeleted: string[];
  /** Fails the delete before any state change (as if the request never reached the server). */
  failRemove: Error | null;
  /** Fails the delete after the soft-delete step landed, mirroring an interrupted batch loop. */
  failRemoveMidDelete: Error | null;
  failUpdate: Error | null;
  failCreate: Error | null;
  failGet: boolean;
};

let fixtureCounter = 0;

const nextProjectId = () => {
  fixtureCounter += 1;
  return `fixture-project-${fixtureCounter}`;
};

/**
 * Deterministic in-memory backend for component tests. Switch `listMode` to
 * exercise loading/error/retry; the counters make every CRUD call observable.
 */
export function fixtureBackend(seed: ProjectSummary[] = []): { backend: ProjectsBackend; state: FixtureState } {
  const state: FixtureState = {
    projects: [...seed],
    listMode: "ok",
    listCalls: 0,
    created: [],
    updated: [],
    removed: [],
    softDeleted: [],
    failCreate: null,
    failUpdate: null,
    failRemove: null,
    failRemoveMidDelete: null,
    failGet: false,
  };

  const backend: ProjectsBackend = {
    async list() {
      state.listCalls += 1;
      if (state.listMode === "pending") return new Promise<ProjectSummary[]>(() => undefined);
      if (state.listMode === "error") throw new Error("fixture list failed");
      return [...state.projects];
    },
    async get(id) {
      if (state.failGet) throw new Error("fixture get failed");
      const found = state.projects.find((project) => project.id === id);
      if (found === undefined) throw new Error("NOT_FOUND");
      return found;
    },
    async create(draft) {
      if (state.failCreate !== null) throw state.failCreate;
      const id = nextProjectId();
      state.created.push(draft);
      state.projects.push({ id, name: draft.name, goal: draft.goal, mode: draft.mode, createdAt: state.created.length });
      return id;
    },
    async update(id, patch) {
      if (state.failUpdate !== null) throw state.failUpdate;
      state.updated.push({ id, patch });
      const index = state.projects.findIndex((project) => project.id === id);
      if (index >= 0) {
        const current = state.projects[index];
        state.projects[index] = { ...current, name: patch.name, goal: patch.goal === "" ? undefined : patch.goal, mode: patch.mode ?? current.mode };
      }
    },
    async remove(id) {
      if (state.failRemove !== null) throw state.failRemove;
      // Phase 1 mirrors `requestProjectDeletion`: the soft-delete hides the
      // project from the next list load even though its rows still exist.
      if (!state.softDeleted.includes(id)) {
        state.softDeleted.push(id);
        state.projects = state.projects.filter((project) => project.id !== id);
      }
      if (state.failRemoveMidDelete !== null) throw state.failRemoveMidDelete;
      // Phase 2 mirrors the bounded batches; a re-run resumes this cleanup.
      state.softDeleted = state.softDeleted.filter((pending) => pending !== id);
      if (!state.removed.includes(id)) state.removed.push(id);
    },
  };

  return { backend, state };
}

export const project = (overrides: Partial<ProjectSummary> & { id: string; name: string }): ProjectSummary => ({
  createdAt: 1_760_000_000_000,
  ...overrides,
});

/**
 * A `ConvexReactClient`-shaped adapter over any `{ query, mutation }` target
 * (convex-test in the E2E suite); the production backend only needs these two
 * methods.
 */
export function asConvexClient(target: { query: unknown; mutation: unknown }): Pick<ConvexReactClient, "query" | "mutation"> {
  return target as unknown as Pick<ConvexReactClient, "query" | "mutation">;
}
