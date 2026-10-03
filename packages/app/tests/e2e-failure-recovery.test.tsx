// @vitest-environment jsdom
import { convexTest } from "convex-test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api, internal } from "../../api/convex/_generated/api.js";
import schema from "../../api/convex/schema.js";
import { EMAIL, installAuthTestEnv, PASSWORD } from "../../api/tests/helpers/authEnv.js";
import { SpokenConversation } from "../src/SpokenConversation.js";
import type { CaptureRecording, CaptureSubscription } from "../src/turnController.js";
import { ensureSubtleCrypto } from "./jsdomCrypto.js";
import {
  allRows,
  dynamicClient,
  expectNoDuplicateTurns,
  realAuthSession,
  releaseVoicePorts,
  signUpLearner,
  uploadFixture,
  type DynamicClient,
  type Id,
  type TestInstance,
} from "./helpers/releaseHarness.js";
import { captureHarness, installVoiceProviderMock, QUESTION } from "./helpers/voiceConversation.js";

/**
 * S26 acceptance criterion 4: failure recovery WITHOUT duplicate turns.
 * Every scenario runs through the real UI against the real authorized Convex
 * functions and ends with server row counts proving no duplicate
 * tutorTurns/messages:
 *
 *   1. microphone denial (NotAllowedError) -> blocked -> Try again -> one turn
 *   2. provider 429 (injected once) -> in-action retry -> one turn
 *   3. persistent provider 429 -> visible failure -> UI Retry -> one turn
 *   4. provider timeout (injected hang) -> in-action retry -> one turn
 *   5. parser-failure job state -> retryDocument -> re-ingest with no
 *      duplicate job/chunk rows, then the journey continues with a turn
 *   6. cancellation while generating -> cancelled row, zero messages -> new turn
 *
 * Providers are the offline NaN mock; no live call is made.
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
  delete process.env.TUTOR_TIMEOUT_MS;
  delete process.env.TURN_CANCEL_POLL_MS;
  cleanup();
});

const STAGE_LABELS: Record<string, string> = {
  listening: "Listening",
  generating: "Retrieving & generating",
  speaking: "Speaking",
  ready: "Ready",
};

function stageResult(stage: string): string | null {
  return screen.getByText(STAGE_LABELS[stage]).closest("li")?.querySelector(".stage-result")?.textContent ?? null;
}

type Scenario = { t: TestInstance; client: DynamicClient; projectId: Id<"projects"> };

/** A signed-in learner (real Convex Auth action) with one owned project. */
async function setupScenario(name: string): Promise<Scenario> {
  const t = convexTest({ schema, modules });
  const ownerId = await signUpLearner(t);
  process.env.NAN_DEPLOYER_ID = ownerId;
  const client = dynamicClient(t);
  const state = { authenticated: false };
  const session = realAuthSession(client, state);
  await session.signIn({ flow: "signIn", email: EMAIL, password: PASSWORD });
  expect(state.authenticated).toBe(true);
  const projectId = await client.instance().mutation(api.projects.createProject, { name });
  return { t, client, projectId };
}

async function rowCounts(t: TestInstance) {
  const turns = await allRows<{ turnId: string; status: string; failureCode?: string | null }>(t, "tutorTurns");
  const messages = await allRows<{ turnId: string; role: string; idempotencyKey?: string }>(t, "messages");
  return { turns, messages };
}

/** Selects the transcribe action so a click on Record starts the machine. */
async function selectTranscribe(): Promise<void> {
  await userEvent.click(await screen.findByRole("radio", { name: /Transcribe speech/ }));
}

test("microphone denial blocks before any server row, then Try again completes exactly one turn", async () => {
  const { t, client, projectId } = await setupScenario("Mic recovery");
  let denied = true;
  const device = captureHarness().env;
  const ports = releaseVoicePorts(client, {
    capture: {
      startMicrophone: async (mimeType: string, subscription: CaptureSubscription): Promise<CaptureRecording> => {
        if (denied) {
          denied = false;
          throw new DOMException("Permission denied", "NotAllowedError");
        }
        return device.startMicrophone(mimeType, subscription);
      },
    },
  });
  render(<SpokenConversation projectId={projectId} conversation={ports.backend} capture={ports.capture} playback={ports.playback} />);
  const user = userEvent.setup();

  await selectTranscribe();
  await user.click(screen.getByRole("button", { name: "Record a turn" }));

  // The denial surfaces as an actionable capture failure in the stage
  // status and the capture panel; the server was never reached, so no turn
  // or message row exists.
  const denialAlerts = await screen.findAllByText(/permission/i, {}, { timeout: 5_000 });
  expect(denialAlerts.length).toBeGreaterThanOrEqual(2);
  const blocked = await rowCounts(t);
  expect(blocked.turns).toHaveLength(0);
  expect(blocked.messages).toHaveLength(0);

  // Try again: the same machine records, transcribes, generates and speaks.
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 10_000 });
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"), { timeout: 10_000 });
  ports.playbacks[0].ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"), { timeout: 10_000 });

  const recovered = await rowCounts(t);
  expect(recovered.turns).toHaveLength(1);
  expect(recovered.turns[0].status).toBe("completed");
  expect(recovered.messages).toHaveLength(2);
  expectNoDuplicateTurns(recovered.turns, recovered.messages);
}, 60_000);

test("an injected provider 429 recovers inside the same turn without a second row", async () => {
  const { t, client, projectId } = await setupScenario("Rate limit recovery");
  provider.queueChat("rate-limit", "ok");
  const ports = releaseVoicePorts(client);
  render(<SpokenConversation projectId={projectId} conversation={ports.backend} capture={ports.capture} playback={ports.playback} />);

  await selectTranscribe();
  await userEvent.click(screen.getByRole("button", { name: "Record a turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 10_000 });
  await userEvent.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"), { timeout: 10_000 });
  ports.playbacks[0].ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"), { timeout: 10_000 });

  // One HTTP 429 was injected and retried in place: two chat calls, one
  // turn row, two messages, no visible failure.
  expect(provider.counts.chat).toBe(2);
  const { turns, messages } = await rowCounts(t);
  expect(turns).toHaveLength(1);
  expect(turns[0].status).toBe("completed");
  expect(messages).toHaveLength(2);
  expectNoDuplicateTurns(turns, messages);
}, 60_000);

test("a persistent provider 429 fails visibly and the UI Retry completes without duplicates", async () => {
  const { t, client, projectId } = await setupScenario("Rate limit visible failure");
  // Exhausts the three in-action attempts, then allows the manual retry.
  provider.queueChat("rate-limit", "rate-limit", "rate-limit", "ok");
  const ports = releaseVoicePorts(client);
  render(<SpokenConversation projectId={projectId} conversation={ports.backend} capture={ports.capture} playback={ports.playback} />);
  const user = userEvent.setup();

  await selectTranscribe();
  await user.click(screen.getByRole("button", { name: "Record a turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 10_000 });
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));

  // The turn fails visibly at generating with rate-limit copy and a Retry.
  await screen.findByText(/rate limited/i, {}, { timeout: 15_000 });
  const failed = await rowCounts(t);
  expect(failed.messages).toHaveLength(0);

  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"), { timeout: 15_000 });
  const playback = ports.playbacks[ports.playbacks.length - 1];
  playback.ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"), { timeout: 10_000 });

  const { turns, messages } = await rowCounts(t);
  const completed = turns.filter((turn) => turn.status === "completed");
  const failedRows = turns.filter((turn) => turn.status === "failed");
  // The persistent 429 fails the first turn visibly (fresh-id retry for a
  // terminal failure), then the manual Retry completes exactly one turn.
  expect(turns).toHaveLength(2);
  expect(completed).toHaveLength(1);
  expect(failedRows).toHaveLength(1);
  expect(messages).toHaveLength(2);
  // Rows never duplicate a turn or a message for the learner's utterance.
  const stats = expectNoDuplicateTurns(turns, messages);
  expect(stats.distinctTurnIds).toBe(2);
  for (const turn of failedRows) expect(messages.filter((message) => message.turnId === turn.turnId)).toHaveLength(0);
  expect(messages.every((message) => message.turnId === completed[0].turnId)).toBe(true);
  expect(provider.counts.chat).toBe(4);
}, 60_000);

test("an injected provider timeout recovers inside the same turn without a second row", async () => {
  const { t, client, projectId } = await setupScenario("Timeout recovery");
  process.env.TUTOR_TIMEOUT_MS = "100";
  provider.queueChat("hang", "ok");
  const ports = releaseVoicePorts(client);
  render(<SpokenConversation projectId={projectId} conversation={ports.backend} capture={ports.capture} playback={ports.playback} />);

  await selectTranscribe();
  await userEvent.click(screen.getByRole("button", { name: "Record a turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 10_000 });
  await userEvent.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"), { timeout: 15_000 });
  ports.playbacks[0].ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"), { timeout: 10_000 });

  expect(provider.counts.chat).toBe(2);
  const { turns, messages } = await rowCounts(t);
  expect(turns).toHaveLength(1);
  expect(turns[0].status).toBe("completed");
  expect(messages).toHaveLength(2);
  expectNoDuplicateTurns(turns, messages);
}, 60_000);

test("a parser-failure job recovers through retryDocument with no duplicate job or chunk rows", async () => {
  const { t, client, projectId } = await setupScenario("Parser recovery");
  const a = client.instance();
  const uploaded = await uploadFixture(t, client.subject.current, projectId, "lesson.md", "parser-recovery-0001");
  const firstCycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-parser" });
  expect(firstCycle.outcomes[0]?.outcome).toBe("succeeded");
  const healthyChunks = await allRows<{ _id: string }>(t, "documentChunks");
  expect(healthyChunks.length).toBeGreaterThan(0);

  // Inject the parser-failure outcome exactly where the real runner records
  // it (the recovery path below is real; the failing parse itself cannot be
  // reproduced deterministically offline without timing the parser).
  await t.run(async (ctx) => {
    const job = await ctx.db.get(uploaded.jobId as never);
    const document = await ctx.db.get(uploaded.documentId as never);
    if (job !== null) await ctx.db.patch(job._id, { status: "failed", attempts: 3, failureCode: "PARSE_FAILED", updatedAt: Date.now() });
    if (document !== null) await ctx.db.patch(document._id, { status: "failed", failureCode: "PARSE_FAILED", updatedAt: Date.now() });
  });
  const broken = await a.query(api.documents.listDocumentStatuses, { projectId });
  expect(broken[0]?.document).toMatchObject({ status: "failed", failureCode: "PARSE_FAILED" });
  const brokenJobs = await a.query(api.ingestion.listIngestionJobs, { projectId });
  expect(brokenJobs[0]).toMatchObject({ status: "failed", failureCode: "PARSE_FAILED" });

  // Real recovery: re-arm once (idempotent), re-run the real parse/embed
  // pipeline, and land on ready with byte-identical chunk rows.
  const retry = await a.mutation(api.documents.retryDocument, { projectId, documentId: uploaded.documentId as never });
  expect(retry.retried).toBe(true);
  const replay = await a.mutation(api.documents.retryDocument, { projectId, documentId: uploaded.documentId as never });
  expect(replay.retried).toBe(false);
  const jobsAfterRetry = await allRows<{ _id: string }>(t, "ingestionJobs");
  expect(jobsAfterRetry).toHaveLength(1);

  const retryCycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-parser-2" });
  expect(retryCycle.outcomes[0]?.outcome).toBe("succeeded");
  const ready = await a.query(api.documents.listDocumentStatuses, { projectId });
  expect(ready[0]?.document.status).toBe("ready");
  const recoveredChunks = await allRows<{ _id: string }>(t, "documentChunks");
  expect(recoveredChunks.map((chunk) => chunk._id).sort()).toEqual(healthyChunks.map((chunk) => chunk._id).sort());
  expect(await allRows(t, "ingestionJobs")).toHaveLength(1);

  // The journey continues: a spoken turn still completes, exactly once.
  const ports = releaseVoicePorts(client);
  render(<SpokenConversation projectId={projectId} conversation={ports.backend} capture={ports.capture} playback={ports.playback} />);
  await selectTranscribe();
  await userEvent.click(screen.getByRole("button", { name: "Record a turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 10_000 });
  await userEvent.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"), { timeout: 10_000 });
  ports.playbacks[0].ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"), { timeout: 10_000 });

  const { turns, messages } = await rowCounts(t);
  expect(turns).toHaveLength(1);
  expect(messages).toHaveLength(2);
  expectNoDuplicateTurns(turns, messages);
}, 60_000);

test("cancelling while generating stores a cancelled turn with zero messages, and the next turn completes once", async () => {
  const { t, client, projectId } = await setupScenario("Cancellation recovery");
  process.env.TURN_CANCEL_POLL_MS = "50";
  provider.queueChat("hang");
  const ports = releaseVoicePorts(client);
  render(<SpokenConversation projectId={projectId} conversation={ports.backend} capture={ports.capture} playback={ports.playback} />);
  const user = userEvent.setup();

  await selectTranscribe();
  await user.click(screen.getByRole("button", { name: "Record a turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 10_000 });
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("generating")).toBe("in progress"), { timeout: 10_000 });

  // Cancel while the provider call is in flight.
  await user.click(screen.getByRole("button", { name: "Cancel turn" }));
  await waitFor(() => expect(stageResult("generating")).not.toBe("in progress"), { timeout: 10_000 });

  // Server truth after the cancel: one cancelled turn, no messages, no
  // citations — never a partial commit.
  await waitFor(async () => {
    const cancelled = await rowCounts(t);
    expect(cancelled.turns).toHaveLength(1);
    expect(cancelled.turns[0].status).toBe("cancelled");
    expect(cancelled.messages).toHaveLength(0);
    expect(await allRows(t, "citations")).toHaveLength(0);
  }, { timeout: 10_000 });

  // A fresh turn from the resting state completes exactly once. The chat
  // queue is empty now, so this call streams the deterministic answer.
  await completeFreshTurn(ports);

  const { turns, messages } = await rowCounts(t);
  expect(turns).toHaveLength(2);
  expect(turns.filter((turn) => turn.status === "completed")).toHaveLength(1);
  expect(turns.filter((turn) => turn.status === "cancelled")).toHaveLength(1);
  expect(messages).toHaveLength(2);
  expectNoDuplicateTurns(turns, messages);
}, 60_000);

async function completeFreshTurn(ports: ReturnType<typeof releaseVoicePorts>): Promise<void> {
  const user = userEvent.setup();
  const record = await screen.findByRole("button", { name: /Record (a|another) turn/ });
  await user.click(record);
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 10_000 });
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"), { timeout: 10_000 });
  const history = within(screen.getByRole("region", { name: "Conversation history" }));
  expect(await history.findByText(QUESTION)).toBeTruthy();
  ports.playbacks[ports.playbacks.length - 1].ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"), { timeout: 10_000 });
}
