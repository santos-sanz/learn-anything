import { createRoot } from "react-dom/client";

import { Root } from "./Root.js";
import type { ProjectDraft, ProjectPatch, ProjectSummary, ProjectsBackend } from "./data/projects.js";

/**
 * Dev-only preview fixtures for local screenshot evidence. Reached exclusively
 * through the `import.meta.env.DEV` branch in `main.tsx`, which is stripped
 * from production builds; every value below is synthetic.
 */

const PROJECTS: Record<string, ProjectSummary> = {
  "preview-spanish": { id: "preview-spanish", name: "Spanish conversation", goal: "Hold a five-minute chat about my weekend", mode: "language-practice", createdAt: 1_760_000_000_000 },
  "preview-linear": { id: "preview-linear", name: "Linear algebra foundations", goal: "Understand eigenvectors well enough to explain them", mode: "concept-learning", createdAt: 1_760_000_100_000 },
  "preview-guitar": { id: "preview-guitar", name: "Guitar chords", mode: "language-practice", createdAt: 1_760_000_200_000 },
};

type PreviewCase = "dashboard" | "onboarding" | "detail" | "loading" | "error";

const TARGETS: Record<PreviewCase, { hash: string; projects: ProjectSummary[] }> = {
  dashboard: { hash: "#/projects", projects: [PROJECTS["preview-spanish"], PROJECTS["preview-linear"], PROJECTS["preview-guitar"]] },
  onboarding: { hash: "#/projects/new", projects: [] },
  detail: { hash: "#/projects/preview-spanish", projects: [PROJECTS["preview-spanish"]] },
  loading: { hash: "#/projects", projects: [] },
  error: { hash: "#/projects", projects: [] },
};

function fixtureBackend(projects: ProjectSummary[], behaviour: PreviewCase): ProjectsBackend {
  const list = async (): Promise<ProjectSummary[]> => {
    if (behaviour === "loading") return new Promise<never>(() => undefined);
    if (behaviour === "error") throw new Error("preview-error");
    return projects;
  };
  return {
    list,
    async get(id) {
      const found = projects.find((project) => project.id === id);
      if (found === undefined) throw new Error("preview-error");
      return found;
    },
    async create(draft: ProjectDraft) {
      const id = `preview-${draft.name.toLowerCase().replace(/\W+/g, "-")}`;
      projects.push({ id, name: draft.name, goal: draft.goal, mode: draft.mode, createdAt: Date.now() });
      return id;
    },
    async update(id: string, patch: ProjectPatch) {
      const index = projects.findIndex((project) => project.id === id);
      if (index >= 0) {
        const current = projects[index];
        projects[index] = { ...current, name: patch.name, goal: patch.goal === "" ? undefined : patch.goal, mode: patch.mode ?? current.mode };
      }
    },
    async remove(id: string) {
      const index = projects.findIndex((project) => project.id === id);
      if (index >= 0) projects.splice(index, 1);
    },
  };
}

export function mountPreview(root: HTMLElement): void {
  const raw = window.location.hash.slice("#/preview/".length).split(/[?&]/)[0];
  const previewCase = (raw in TARGETS ? raw : "dashboard") as PreviewCase;
  const target = TARGETS[previewCase];
  const session = {
    isLoading: false,
    isAuthenticated: true,
    signIn: async () => undefined,
    signOut: async () => undefined,
  };

  // Land on the real route before mounting so the router reads the final hash.
  window.location.hash = target.hash;
  createRoot(root).render(<Root session={session} backend={fixtureBackend([...target.projects], previewCase)} />);
}
