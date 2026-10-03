import { createRoot } from "react-dom/client";

import { Root } from "./Root.js";
import type { ProjectDraft, ProjectPatch, ProjectSummary, ProjectsBackend } from "./data/projects.js";
import type { SpeechOptions, TutorBackend } from "./data/tutor.js";
import type { ResponsePlayerEnvironment } from "./playerController.js";
import { TutorResponseSection } from "./TutorResponseSection.js";
import type { TtsResult } from "./ttsClient.js";

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

/* ------------------------------------------------------------------ *
 * S16 player preview: synthetic tutor response + playback behaviour
 * ------------------------------------------------------------------ */

type PlayerPreviewCase = "playing" | "blocked" | "failed";

const PLAYER_PREVIEW_CASES: readonly PlayerPreviewCase[] = ["playing", "blocked", "failed"];

const PREVIEW_TRANSCRIPT =
  "Photosynthesis is how plants turn light into stored chemical energy [1]. Chlorophyll in the leaf absorbs sunlight and drives the reaction that produces glucose [2].";

const PREVIEW_SPEECH_OPTIONS: SpeechOptions = {
  model: "kokoro",
  format: "mp3",
  languages: ["en", "es"],
  voices: [
    { id: "af_heart", language: "en", label: "English (af_heart)" },
    { id: "ef_dora", language: "es", label: "Spanish (ef_dora)" },
  ],
  maxTextChars: 20_000,
};

function previewTutorBackend(): TutorBackend {
  return {
    async latestResponse() {
      return { turnId: "turn-1", text: PREVIEW_TRANSCRIPT, createdAt: 1_760_000_000_000 };
    },
    async latestTurn() {
      return { turnId: "turn-2", status: "running", createdAt: 1_760_000_100_000 };
    },
    async speechOptions() {
      return PREVIEW_SPEECH_OPTIONS;
    },
    async cancelTurn() {
      // Preview fixtures never talk to a backend.
    },
  };
}

function previewPlayerEnvironment(playerCase: PlayerPreviewCase): ResponsePlayerEnvironment {
  const audio = new Blob([new Uint8Array([0x49, 0x44, 0x33, 0x04])], { type: "audio/mpeg" });
  return {
    async fetchAudio(): Promise<TtsResult> {
      if (playerCase === "failed") {
        return {
          ok: false,
          code: "rate-limited",
          message: "",
          retryAfterMs: 30_000,
          supportedVoices: null,
          supportedLanguages: null,
        };
      }
      return { ok: true, audio, contentType: "audio/mpeg" };
    },
    async createPlayback() {
      let attempts = 0;
      return {
        async play() {
          attempts += 1;
          if (playerCase === "blocked" && attempts === 1) {
            throw new DOMException("play() was blocked by the autoplay policy", "NotAllowedError");
          }
        },
        pause() {},
        dispose() {},
        onEnded: null,
        onError: null,
      };
    },
  };
}

function PlayerPreview({ playerCase }: { playerCase: PlayerPreviewCase }) {
  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">Learn Anything</span>
      </header>
      <main className="app-main">
        <section className="screen" aria-labelledby="preview-project-heading">
          <div className="screen-header">
            <h1 id="preview-project-heading">Spanish conversation</h1>
          </div>
          <div className="project-summary">
            <p className="badge">Language practice</p>
            <p className="card-goal">Hold a five-minute chat about my weekend</p>
          </div>
          <h2>Tutor</h2>
          <TutorResponseSection
            projectId="preview-spanish"
            backend={previewTutorBackend()}
            siteUrl="https://preview-convex.example"
            environment={previewPlayerEnvironment(playerCase)}
          />
        </section>
      </main>
    </div>
  );
}

export function mountPreview(root: HTMLElement): void {
  const raw = window.location.hash.slice("#/preview/".length).split(/[?&]/)[0];
  if (raw.startsWith("player")) {
    const playerCase: PlayerPreviewCase = (PLAYER_PREVIEW_CASES.find((name) => raw === `player-${name}`) ?? "playing") as PlayerPreviewCase;
    createRoot(root).render(<PlayerPreview playerCase={playerCase} />);
    return;
  }
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
