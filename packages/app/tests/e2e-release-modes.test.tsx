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
import { ensureSubtleCrypto } from "./jsdomCrypto.js";
import {
  allRows,
  dynamicClient,
  expectNoDuplicateTurns,
  realAuthSession,
  releaseBackends,
  releaseVoicePorts,
  signUpLearner,
  uploadFixture,
} from "./helpers/releaseHarness.js";
import { installVoiceProviderMock, QUESTION } from "./helpers/voiceConversation.js";

/**
 * S26 acceptance criterion 2: BOTH tutor modes work end to end. Each mode
 * runs a real grounded spoken turn through the real STT/tutor/TTS routes
 * (transcript, citation links and TTS playback in the conversation history)
 * and proves its mode-specific server effect — the S19 language-practice
 * system prompt plus a practised-topic row, and the S20 concept-learning
 * track prompt plus a concept activity progress event. Providers are the
 * offline NaN mock; no live call is made.
 */

installAuthTestEnv();
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

const OBJECTIVE = "Explain how plants store energy";

const STAGE_LABELS: Record<string, string> = {
  listening: "Listening",
  speaking: "Speaking",
  ready: "Ready",
};

function stageResult(stage: string): string | null {
  return screen.getByText(STAGE_LABELS[stage]).closest("li")?.querySelector(".stage-result")?.textContent ?? null;
}

/** One full spoken turn against the real routes: capture -> transcribe -> generate -> play -> ready. */
async function spokenTurn(projectId: string, ports: ReturnType<typeof releaseVoicePorts>): Promise<void> {
  const user = userEvent.setup();
  render(<SpokenConversation projectId={projectId} conversation={ports.backend} capture={ports.capture} playback={ports.playback} />);
  await user.click(await screen.findByRole("radio", { name: /Transcribe speech/ }));
  await user.click(screen.getByRole("button", { name: "Record a turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 10_000 });
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"), { timeout: 10_000 });
  const history = within(screen.getByRole("region", { name: "Conversation history" }));
  expect(await history.findByText(QUESTION)).toBeTruthy();
  expect(history.getByText((content) => content.includes("Plants turn light into chemical energy"))).toBeTruthy();
  await waitFor(() => expect(history.getAllByRole("link", { name: /^1\. / })).toHaveLength(1), { timeout: 10_000 });
  const playback = ports.playbacks[ports.playbacks.length - 1];
  expect(playback).toBeDefined();
  playback.ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"), { timeout: 10_000 });
  cleanup();
}

test("language-practice and concept-learning each run a grounded spoken turn with transcripts, citations and TTS playback", async () => {
  const t = convexTest({ schema, modules });
  const ownerId = await signUpLearner(t);
  process.env.NAN_DEPLOYER_ID = ownerId;

  const client = dynamicClient(t);
  const state = { authenticated: false };
  const session = realAuthSession(client, state);
  const { projects, documents } = releaseBackends(client);
  const user = userEvent.setup();

  // Sign in through the real Convex Auth action (shared journey preamble).
  window.location.hash = "#/projects";
  render(<Root session={session} backend={projects} documents={documents} />);
  await user.type(await screen.findByLabelText("Email"), "learner@example.test");
  await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "Create your first project" });
  cleanup();

  const a = client.instance();

  // -- S19: a configured language-practice project. ----------------------
  const languageProject = await a.mutation(api.projects.createProject, {
    name: "Spanish weekend",
    goal: "Hold a five-minute chat about my weekend",
    mode: "language-practice",
  });
  await a.mutation(api.languagePractice.updateLanguagePracticeConfig, {
    projectId: languageProject,
    config: {
      targetLanguage: "es",
      level: "beginner",
      correctionStyle: "immediate",
      goals: ["Hold a five-minute chat about my weekend"],
      roleplayScenarios: ["Ordering coffee in a café"],
    },
  });

  // -- S20: a concept-learning project with an objective selection. ------
  const conceptProject = await a.mutation(api.projects.createProject, {
    name: "Biology",
    goal: "Pass the biology exam",
    mode: "concept-learning",
  });
  await a.mutation(api.concept.selectObjectiveAndDifficulty, {
    projectId: conceptProject,
    objective: OBJECTIVE,
    difficulty: "intermediate",
  });

  // Ground both projects with the same synthetic corpus (real HTTP upload).
  await uploadFixture(t, client.subject.current, languageProject, "lesson.md", "modes-lang-0001");
  await uploadFixture(t, client.subject.current, conceptProject, "lesson.md", "modes-concept-0001");
  await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-modes-1" });
  await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-modes-2" });
  const languageDoc = await a.query(api.documents.listDocumentStatuses, { projectId: languageProject });
  const conceptDoc = await a.query(api.documents.listDocumentStatuses, { projectId: conceptProject });
  expect(languageDoc[0]?.document.status).toBe("ready");
  expect(conceptDoc[0]?.document.status).toBe("ready");

  // -- Spoken turn in language-practice mode. ----------------------------
  const ports = releaseVoicePorts(client);
  await spokenTurn(languageProject, ports);

  // -- Spoken turn in concept-learning mode. -----------------------------
  await spokenTurn(conceptProject, ports);

  // Mode-specific server truth from the exact prompts the provider received.
  expect(provider.chatSystems).toHaveLength(2);
  expect(provider.chatSystems[0]).toContain("Language-practice mode (project settings;");
  expect(provider.chatSystems[0]).toContain("Learning language: Spanish");
  expect(provider.chatSystems[1]).toContain("Project track: concept learning.");

  // S19 recorded exactly one practised topic for the language turn only.
  const practised = await allRows<{ turnId: string; targetLanguage: string }>(t, "practisedTopics");
  expect(practised).toHaveLength(1);
  expect(practised[0].targetLanguage).toBe("es");

  // -- S20 progress event through the real concept activity action. ------
  const activity = (await a.action(api.concept.runActivity, {
    projectId: conceptProject,
    turnId: "concept-activity-1",
    activity: "explain",
    text: "Explain how plants store energy from sunlight",
  })) as { text: string };
  expect(activity.text.length).toBeGreaterThan(0);
  const events = await allRows<{ eventType: string; objective: string; turnId: string }>(t, "progressEvents");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ eventType: "activity-completed", objective: OBJECTIVE, turnId: "concept-activity-1" });
  expect(provider.chatSystems[2]).toContain(OBJECTIVE);

  // Row truth: three distinct completed turns, six messages, three
  // citations — every turn owns exactly one learner and one tutor message.
  const turns = await allRows<{ turnId: string; status: string }>(t, "tutorTurns");
  const messages = await allRows<{ turnId: string; role: string; idempotencyKey?: string }>(t, "messages");
  const citations = await allRows<{ turnId: string }>(t, "citations");
  expect(turns).toHaveLength(3);
  expect(turns.every((turn) => turn.status === "completed")).toBe(true);
  expect(messages).toHaveLength(6);
  expect(citations).toHaveLength(3);
  expectNoDuplicateTurns(turns, messages);

  expect(provider.counts.transcriptions).toBe(2);
  expect(provider.counts.speech).toBe(2);
  expect(provider.counts.chat).toBe(3);
}, 60_000);
