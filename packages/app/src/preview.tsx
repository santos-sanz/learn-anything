import { createRoot } from "react-dom/client";

import { CitationLink, type CitationReference } from "./components/CitationLink.js";
import type { DocumentItem, DocumentsBackend, SourceChunk, SourceView } from "./data/documents.js";
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

const now = 1_760_000_300_000;

/** One row per S09 job state so a single screenshot covers every badge. */
const DOCUMENT_ITEMS: DocumentItem[] = [
  {
    id: "preview-doc-1",
    filename: "spanish-notes.pdf",
    extension: "pdf",
    contentType: "application/pdf",
    sizeBytes: 188_416,
    status: "ready",
    failureCode: null,
    createdAt: now,
    updatedAt: now,
    job: { id: "preview-job-1", status: "succeeded", attempts: 1, maxAttempts: 5, failureCode: null, nextAttemptAt: null, chunkCount: 6, updatedAt: now },
  },
  {
    id: "preview-doc-2",
    filename: "verb-conjugations.md",
    extension: "md",
    contentType: "text/markdown",
    sizeBytes: 12_288,
    status: "pending",
    failureCode: null,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    job: { id: "preview-job-2", status: "running", attempts: 1, maxAttempts: 5, failureCode: null, nextAttemptAt: null, chunkCount: null, updatedAt: now - 60_000 },
  },
  {
    id: "preview-doc-3",
    filename: "weekend-dialogue.txt",
    extension: "txt",
    contentType: "text/plain",
    sizeBytes: 4_096,
    status: "pending",
    failureCode: null,
    createdAt: now - 120_000,
    updatedAt: now - 90_000,
    job: { id: "preview-job-3", status: "queued", attempts: 2, maxAttempts: 5, failureCode: "PARSE_FAILED", nextAttemptAt: now + 30_000, chunkCount: null, updatedAt: now - 90_000 },
  },
  {
    id: "preview-doc-4",
    filename: "unit-7-scan.pdf",
    extension: "pdf",
    contentType: "application/pdf",
    sizeBytes: 2_097_152,
    status: "failed",
    failureCode: "ENCRYPTED_PDF",
    createdAt: now - 180_000,
    updatedAt: now - 170_000,
    job: { id: "preview-job-4", status: "unsupported", attempts: 1, maxAttempts: 5, failureCode: "ENCRYPTED_PDF", nextAttemptAt: null, chunkCount: null, updatedAt: now - 170_000 },
  },
  {
    id: "preview-doc-5",
    filename: "broken-upload.pdf",
    extension: "pdf",
    contentType: "application/pdf",
    sizeBytes: 9_714_688,
    status: "failed",
    failureCode: "PARSE_FAILED",
    createdAt: now - 240_000,
    updatedAt: now - 200_000,
    job: { id: "preview-job-5", status: "failed", attempts: 5, maxAttempts: 5, failureCode: "PARSE_FAILED", nextAttemptAt: null, chunkCount: null, updatedAt: now - 200_000 },
  },
];

const SOURCE_DOCUMENT = { filename: "spanish-notes.pdf", extension: "pdf", contentType: "application/pdf", sizeBytes: 188_416 };

const SOURCE_CHUNKS: SourceChunk[] = [
  { chunkId: "preview-chunk-1", seq: 0, page: 1, heading: null, text: "Notas de la conversación: hablar del fin de semana, el tiempo y los planes.", contentHash: "preview-hash-0001" },
  { chunkId: "preview-chunk-2", seq: 1, page: 2, heading: null, text: "Vocabulario clave: quedar con amigos, hacer la compra, salir a pasear. El uso del pretérito frente al imperfecto aparece en cada ejemplo de esta página.", contentHash: "preview-hash-0002" },
  { chunkId: "preview-chunk-3", seq: 2, page: null, heading: "Practice routine", text: "Un guion de cinco minutos: saluda, cuenta tu fin de semana, haz dos preguntas y cierra la conversación.", contentHash: "preview-hash-0003" },
];

const CITATIONS: CitationReference[] = [
  { documentId: "preview-doc-1", chunkId: "preview-chunk-2", contentHash: "preview-hash-0002", seq: 1, page: 2, heading: null },
  { documentId: "preview-doc-1", chunkId: "preview-chunk-3", contentHash: "preview-hash-0003", seq: 2, page: null, heading: "Practice routine" },
];

type PreviewCase = "dashboard" | "onboarding" | "detail" | "loading" | "error" | "documents" | "source" | "unavailable" | "citations";

const SOURCE_HREF = "#/projects/preview-spanish/sources/preview-doc-1/preview-chunk-2?hash=preview-hash-0002";

const TARGETS: Record<PreviewCase, { hash: string; projects: ProjectSummary[] }> = {
  dashboard: { hash: "#/projects", projects: [PROJECTS["preview-spanish"], PROJECTS["preview-linear"], PROJECTS["preview-guitar"]] },
  onboarding: { hash: "#/projects/new", projects: [] },
  detail: { hash: "#/projects/preview-spanish", projects: [PROJECTS["preview-spanish"]] },
  loading: { hash: "#/projects", projects: [] },
  error: { hash: "#/projects", projects: [] },
  documents: { hash: "#/projects/preview-spanish/documents", projects: [PROJECTS["preview-spanish"]] },
  source: { hash: SOURCE_HREF, projects: [PROJECTS["preview-spanish"]] },
  unavailable: { hash: "#/projects/preview-spanish/sources/preview-doc-1/preview-chunk-9?hash=preview-hash-0009", projects: [PROJECTS["preview-spanish"]] },
  citations: { hash: SOURCE_HREF, projects: [PROJECTS["preview-spanish"]] },
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
        projects[index] = { ...current, name: patch.name, goal: patch.goal, mode: patch.mode ?? current.mode };
      }
    },
    async remove(id: string) {
      const index = projects.findIndex((project) => project.id === id);
      if (index >= 0) projects.splice(index, 1);
    },
  };
}

function fixtureDocumentsBackend(previewCase: PreviewCase): DocumentsBackend {
  const unavailable = previewCase === "unavailable";
  return {
    async list() {
      return DOCUMENT_ITEMS.map((item) => ({ ...item, job: item.job === null ? null : { ...item.job } }));
    },
    async upload(input) {
      return { documentId: input.filename, jobId: "preview-job", filename: input.filename, idempotent: false };
    },
    async retry() {
      return { retried: false };
    },
    async remove() {
      // Preview fixtures are static; deletion screenshots use the real flow.
    },
    async source(reference): Promise<SourceView> {
      if (unavailable) {
        return {
          status: "unavailable",
          reason: "document-deleted",
          document: SOURCE_DOCUMENT,
          source: { chunkId: null, seq: null, page: null, heading: null, contentHash: null },
        };
      }
      const focus = SOURCE_CHUNKS.find((chunk) => chunk.chunkId === reference.chunkId) ?? SOURCE_CHUNKS[1];
      return {
        status: "ok",
        document: SOURCE_DOCUMENT,
        focus,
        before: SOURCE_CHUNKS.filter((chunk) => chunk.seq < focus.seq),
        after: SOURCE_CHUNKS.filter((chunk) => chunk.seq > focus.seq),
      };
    },
  };
}

/** Dev-only list of citations that open the viewer through CitationLink. */
function PreviewCitations({ projectId }: { projectId: string }) {
  return (
    <section className="screen preview-citations" aria-labelledby="preview-citations-heading">
      <h2 id="preview-citations-heading">Cited sources</h2>
      <p className="screen-intro">Citations from the latest tutor answer (preview fixture). Select one to open it at its page or heading.</p>
      <ul className="document-list">
        {CITATIONS.map((citation) => (
          <li key={citation.chunkId}>
            <article className="card">
              <CitationLink projectId={projectId} citation={citation} className="source-context-link" />
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
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
  const tree = (
    <>
      <Root session={session} backend={fixtureBackend([...target.projects], previewCase)} documents={fixtureDocumentsBackend(previewCase)} />
      {previewCase === "citations" && <PreviewCitations projectId="preview-spanish" />}
    </>
  );
  createRoot(root).render(tree);
}
