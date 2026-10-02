import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import type { ProjectDraft, ProjectPatch, ProjectSummary, ProjectsBackend } from "./projects.js";

export type ProjectsState = { status: "loading" } | { status: "error" } | { status: "ready"; projects: ProjectSummary[] };

export type ProjectsContextValue = {
  backend: ProjectsBackend;
  state: ProjectsState;
  reload: () => Promise<void>;
  get: (id: string) => Promise<ProjectSummary>;
  create: (draft: ProjectDraft) => Promise<string>;
  update: (id: string, patch: ProjectPatch) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

const ProjectsContext = createContext<ProjectsContextValue | null>(null);

export function useProjects(): ProjectsContextValue {
  const value = useContext(ProjectsContext);
  if (value === null) throw new Error("useProjects must be used inside ProjectsProvider");
  return value;
}

/**
 * Owns the dashboard's list lifecycle so loading, error and retry states are
 * explicit and testable: the first load shows a status, a failed load shows an
 * actionable error with retry, and every successful mutation refreshes the
 * list. Query errors surface here instead of an error boundary so the UI can
 * offer a next step.
 */
export function ProjectsProvider({ backend, children }: { backend: ProjectsBackend; children: ReactNode }) {
  const [state, setState] = useState<ProjectsState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      const projects = await backend.list();
      setState({ status: "ready", projects });
    } catch {
      setState({ status: "error" });
    }
  }, [backend]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (draft: ProjectDraft) => {
      const id = await backend.create(draft);
      await reload();
      return id;
    },
    [backend, reload],
  );

  const update = useCallback(
    async (id: string, patch: ProjectPatch) => {
      await backend.update(id, patch);
      await reload();
    },
    [backend, reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await backend.remove(id);
      await reload();
    },
    [backend, reload],
  );

  const get = useCallback((id: string) => backend.get(id), [backend]);

  const value: ProjectsContextValue = { backend, state, reload, get, create, update, remove };
  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}
