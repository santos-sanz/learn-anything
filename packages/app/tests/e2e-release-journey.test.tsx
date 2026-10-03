// @vitest-environment jsdom
import { convexTest } from "convex-test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api, internal } from "../../api/convex/_generated/api.js";
import schema from "../../api/convex/schema.js";
import { installAuthTestEnv } from "../../api/tests/helpers/authEnv.js";
import { SpokenConversation } from "../src/SpokenConversation.js";
import { Root } from "../src/Root.js";
import { serializeRoute, parseRoute } from "../src/router.js";
import { ensureSubtleCrypto } from "./jsdomCrypto.js";
import {
  allRows,
  countRows,
  dynamicClient,
  expectNoDuplicateTurns,
  fixtureBytes,
  realAuthSession,
  releaseBackends,
  releaseVoicePorts,
  signUpLearner,
} from "./helpers/releaseHarness.js";
import { installVoiceProviderMock, QUESTION } from "./helpers/voiceConversation.js";

/**
 * S26 full learner journey (acceptance criterion 1), end to end against the
 * in-process Convex test deployment with synthetic fixtures:
 *
 *   real Convex Auth sign-in -> create project (UI) -> upload document (real
 *   authenticated HTTP action) -> S09 ingestion -> TWO spoken grounded turns
 *   (capture -> Whisper STT HTTP action -> scoped retrieval + grounded tutor
 *   with citations -> Kokoro TTS HTTP action -> playback) -> transcripts and
 *   citation links visible in the conversation history -> server row truth:
 *   two turns, four messages, citations, no duplicates.
 *
 * Only the NaN provider layer is mocked (one deterministic answer); no live
 * provider, deployment, credential or network is involved.
 */

// Must run before any convex/ module is invoked (JWT material is synthetic).
installAuthTestEnv();
// Uploads store blobs through convex-test's js syscall, which needs WebCrypto
// even where jsdom's Crypto object shadows Node's (see jsdomCrypto.ts).
ensureSubtleCrypto();

const modules = {
  "../../api/convex/_generated/api.ts": () => import("../../api/convex/_generated/api.js"),
  "../../api/convex/agentSessions.ts": () => import("../../api/convex/agentSessions.js"),
  "../../api/convex/auth.ts": () => import("../../api/convex/auth.js"),
  "../../api/convex/concept.ts": () => import("../../api/convex/concept.js"),
  "../../api/convex/documents.ts": () => import("../../api/convex/documents.js"),
  "../../api/convex/embeddings.ts": () => import("../../api/convex/embeddings.js"),
  "../../api/convex/files.ts": () => import("../../api/convex/files.js"),
  "../../api/convex/http.ts": () => import("../../api/convex/http.js"),
  "../../api/convex/ingestion.ts": () => import("../../api/convex/ingestion.js"),
  "../../api/convex/languagePractice.ts": () => import("../../api/convex/languagePractice.js"),
  "../../api/convex/projects.ts": () => import("../../api/convex/projects.js"),
  "../../api/convex/redirects.ts": () => import("../../api/convex/redirects.js"),
  "../../api/convex/retrieval.ts": () => import("../../api/convex/retrieval.js"),
  "../../api/convex/sources.ts": () => import("../../api/convex/sources.js"),
  "../../api/convex/stt.ts": () => import("../../api/convex/stt.js"),
  "../../api/convex/translation.ts": () => import("../../api/convex/translation.js"),
  "../../api/convex/tutor.ts": () => import("../../api/convex/tutor.js"),
  "../../api/convex/tts.ts": () => import("../../api/convex/tts.js"),
};

let provider: ReturnType<typeof installVoiceProviderMock>;

beforeEach(() => {
  // Synthetic offline credentials only; never a real provider key. The
  // deployer id is pointed at the journey's own learner after sign-up.
  process.env.NAN_API_KEY = "synthetic-test-key";
  process.env.TUTOR_RETRY_BASE_MS = "0";
  provider = installVoiceProviderMock();
  window.location.hash = "";
});

afterEach(() => {
  provider.restore();
  delete process.env.NAN_API_KEY;
  delete process.env.NAN_DEPLOYER_ID;
  delete process.env.TUTOR_RETRY_BASE_MS;
  cleanup();
});

const STAGE_LABELS: Record<string, string> = {
  listening: "Listening",
  transcribing: "Transcribing",
  generating: "Retrieving & generating",
  speaking: "Speaking",
  ready: "Ready",
};

function stageResult(stage: string): string | null {
  return screen.getByText(STAGE_LABELS[stage]).closest("li")?.querySelector(".stage-result")?.textContent ?? null;
}

test("learner A signs in, creates a project, uploads a document and completes two spoken grounded turns with citations", async () => {
  const t = convexTest({ schema, modules });
  // Test setup: the learner account exists before the journey (created via
  // the real password sign-up action); the UI below signs in with it.
  const ownerId = await signUpLearner(t);
  process.env.NAN_DEPLOYER_ID = ownerId;

  const client = dynamicClient(t);
  const state = { authenticated: false };
  const session = realAuthSession(client, state);
  const { projects, documents } = releaseBackends(client);
  const user = userEvent.setup();

  // -- Step 1: sign in through the real Convex Auth action. --------------
  window.location.hash = "#/projects";
  render(<Root session={session} backend={projects} documents={documents} />);
  expect(await screen.findByLabelText("Email")).toBeTruthy();
  expect(screen.queryByText("Create your first project")).toBeNull();

  await user.type(screen.getByLabelText("Email"), "learner@example.test");
  await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "Create your first project" });

  // Server truth behind the sign-in: one real user, one empty project list
  // for the issued identity (not a canned client state).
  const users = await t.run(async (ctx) => ctx.db.query("users").collect());
  expect(users).toHaveLength(1);
  expect(await client.query(api.projects.listProjects, {})).toEqual([]);
  expect(client.ownerId()).toBe(ownerId);

  // -- Step 2: create the project through the UI. ------------------------
  await user.click(await screen.findByRole("link", { name: "Start your first project" }));
  await screen.findByRole("heading", { name: "Set up your first project" });
  await user.type(screen.getByLabelText("Project name"), "Photosynthesis study");
  await user.type(screen.getByLabelText("Learning goal"), "Explain how plants turn light into energy");
  await user.click(screen.getByLabelText("Language practice"));
  await user.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByRole("heading", { level: 1, name: "Photosynthesis study" });
  const landed = parseRoute(window.location.hash);
  const projectId = landed.name === "project" ? landed.id : "";
  expect(projectId).not.toBe("");

  // -- Step 3: upload a document and run the real ingestion cycle. -------
  await user.click(screen.getByRole("link", { name: "Manage documents" }));
  await screen.findByRole("heading", { level: 1, name: "Documents" });
  await user.upload(screen.getByLabelText("Add a document"), new File([fixtureBytes("three-page-lesson.pdf")], "three-page-lesson.pdf", { type: "application/pdf" }));
  await user.click(screen.getByRole("button", { name: "Upload" }));
  await screen.findByText(/uploaded — waiting to process/, {}, { timeout: 5_000 });

  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-journey" });
  expect(cycle.outcomes[0]?.outcome).toBe("succeeded");
  await screen.findByText(/^Ready · \d+ sections?$/, {}, { timeout: 5_000 });
  const chunkCount = await countRows(t, "documentChunks");
  expect(chunkCount).toBeGreaterThan(0);

  // -- Step 4: two spoken grounded turns through the real STT/tutor/TTS
  // routes. The S17 conversation host is rendered with the journey's own
  // project id and identity; ProjectDetail does not expose capture/playback
  // injection points, so the voice steps run in the same component the
  // screen hosts (the documented S17 seam), against the same server state.
  const ports = releaseVoicePorts(client);
  render(<SpokenConversation projectId={projectId} conversation={ports.backend} capture={ports.capture} playback={ports.playback} />);

  // Turn 1: capture -> transcribe -> retrieve/generate with citations -> speak.
  await user.click(await screen.findByRole("radio", { name: /Transcribe speech/ }));
  await user.click(screen.getByRole("button", { name: "Record a turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 10_000 });
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"), { timeout: 10_000 });
  await waitFor(() => expect(ports.playbacks).toHaveLength(1));
  const history = within(screen.getByRole("region", { name: "Conversation history" }));
  expect(await history.findByText(QUESTION)).toBeTruthy();
  expect(history.getByText((content) => content.includes("Plants turn light into chemical energy"))).toBeTruthy();
  // The grounded answer carries at least one resolvable citation link.
  await waitFor(() => expect(history.getAllByRole("link", { name: /^1\. / })).toHaveLength(1));
  ports.playbacks[0].ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"), { timeout: 10_000 });

  // Turn 2: a fresh turn from the resting state, same pipeline.
  await user.click(screen.getByRole("button", { name: "Record another turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 10_000 });
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"), { timeout: 10_000 });
  await waitFor(() => expect(ports.playbacks).toHaveLength(2), { timeout: 10_000 });
  expect(history.getAllByText(QUESTION)).toHaveLength(2);
  await waitFor(() => expect(history.getAllByRole("link", { name: /^1\. / })).toHaveLength(2));
  ports.playbacks[1].ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"), { timeout: 10_000 });

  // -- Step 5: the real app screen shows the same transcripts and
  // citations (server-backed history through the S21 project detail). -----
  cleanup();
  window.location.hash = serializeRoute({ name: "project", id: projectId });
  render(<Root session={session} backend={projects} documents={documents} tutor={ports.backend} />);
  await screen.findByRole("heading", { level: 1, name: "Photosynthesis study" });
  const screenHistory = within(await screen.findByRole("region", { name: "Conversation history" }));
  await waitFor(() => expect(screenHistory.getAllByText(QUESTION)).toHaveLength(2), { timeout: 10_000 });
  expect(screenHistory.getAllByText((content) => content.includes("Plants turn light into chemical energy"))).toHaveLength(2);
  await waitFor(() => expect(screenHistory.getAllByRole("link", { name: /^1\. / })).toHaveLength(2));
  expect(screenHistory.getAllByRole("listitem").length).toBeGreaterThanOrEqual(4);

  // -- Server truth: two completed turns, four messages, citations, no
  // duplicates, exactly one provider round trip per stage per turn. -------
  const turns = await allRows<{ turnId: string; status: string }>(t, "tutorTurns");
  const messages = await allRows<{ turnId: string; role: string; idempotencyKey?: string }>(t, "messages");
  const citations = await allRows<{ turnId: string }>(t, "citations");
  expect(turns).toHaveLength(2);
  expect(turns.every((turn) => turn.status === "completed")).toBe(true);
  expect(messages).toHaveLength(4);
  expect(messages.filter((message) => message.role === "learner")).toHaveLength(2);
  expect(messages.filter((message) => message.role === "tutor")).toHaveLength(2);
  expect(citations).toHaveLength(2);
  expect(citations.every((citation) => turns.some((turn) => turn.turnId === citation.turnId))).toBe(true);
  expectNoDuplicateTurns(turns, messages);
  expect(provider.counts.chat).toBe(2);
  expect(provider.counts.transcriptions).toBe(2);
  expect(provider.counts.speech).toBe(2);
  // One batched embeddings call for all ingestion chunks, plus one query
  // embedding per turn.
  expect(provider.counts.embeddings).toBe(3);
}, 60_000);
