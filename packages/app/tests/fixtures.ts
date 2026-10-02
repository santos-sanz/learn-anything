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
  failCreate: Error | null;
  failUpdate: Error | null;
  failRemove: Error | null;
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
    failCreate: null,
    failUpdate: null,
    failRemove: null,
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
      state.removed.push(id);
      state.projects = state.projects.filter((project) => project.id !== id);
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
