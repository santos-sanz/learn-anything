// @vitest-environment jsdom
import { convexTest } from "convex-test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api } from "../../api/convex/_generated/api.js";
import schema from "../../api/convex/schema.js";
import { installAuthTestEnv, TEST_ISSUER } from "../../api/tests/helpers/authEnv.js";
import { SpokenConversation } from "../src/SpokenConversation.js";
import { QUESTION, convexVoicePorts, installVoiceProviderMock } from "./helpers/voiceConversation.js";

/**
 * S17 end-to-end two-turn voice test: the real UI drives the real authorized
 * Convex functions in-process (convex-test) — Whisper STT through the S15
 * HTTP action, the S14 `runTurn` action with scoped retrieval, and Kokoro
 * TTS through the S16 HTTP action — with only the NaN provider mocked (one
 * deterministic SSE answer). Turn 1 completes, turn 2 completes, and the
 * server ends with exactly two turn rows, four messages and no duplicates;
 * a replayed turn 1 proves the idempotency contract end to end.
 */

// Must run before any convex/ module is imported (JWT material is synthetic).
installAuthTestEnv();



const modules = {
  "../../api/convex/_generated/api.ts": () => import("../../api/convex/_generated/api.js"),
  "../../api/convex/agentSessions.ts": () => import("../../api/convex/agentSessions.js"),
  "../../api/convex/auth.ts": () => import("../../api/convex/auth.js"),
  "../../api/convex/embeddings.ts": () => import("../../api/convex/embeddings.js"),
  "../../api/convex/files.ts": () => import("../../api/convex/files.js"),
  "../../api/convex/http.ts": () => import("../../api/convex/http.js"),
  "../../api/convex/languagePractice.ts": () => import("../../api/convex/languagePractice.js"),
  "../../api/convex/projects.ts": () => import("../../api/convex/projects.js"),
  "../../api/convex/redirects.ts": () => import("../../api/convex/redirects.js"),
  "../../api/convex/retrieval.ts": () => import("../../api/convex/retrieval.js"),
  "../../api/convex/stt.ts": () => import("../../api/convex/stt.js"),
  "../../api/convex/translation.ts": () => import("../../api/convex/translation.js"),
  "../../api/convex/tutor.ts": () => import("../../api/convex/tutor.js"),
  "../../api/convex/tts.ts": () => import("../../api/convex/tts.js"),
};

const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });
let provider: ReturnType<typeof installVoiceProviderMock>;

// Synthetic offline credentials only; never a real provider key.
beforeEach(() => {
  process.env.NAN_API_KEY = "synthetic-test-key";
  process.env.NAN_DEPLOYER_ID = "learner-a";
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

test("two spoken turns complete end to end through the real STT, tutor and TTS routes without duplicates", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("learner-a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice project" });

  // Ports bound to the same authenticated instance: the UI reaches the real
  // functions (identity re-derived server-side on every call).
  const { backend, capture, playback, playbacks } = convexVoicePorts(a);
  render(<SpokenConversation projectId={projectId} conversation={backend} capture={capture} playback={playback} />);
  const user = userEvent.setup();

  // Turn 1: record → transcribe → retrieve/generate → speak → ready.
  await user.click(await screen.findByRole("radio", { name: /Transcribe speech/ }));
  await user.click(screen.getByRole("button", { name: "Record a turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 5_000 });
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"), { timeout: 5_000 });
  expect(await screen.findByRole("region", { name: "Conversation history" })).toBeTruthy();
  await waitFor(() => expect(playbacks).toHaveLength(1));
  playbacks[0].ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"), { timeout: 5_000 });

  // Turn 2: a fresh turn from the resting state, same pipeline.
  await user.click(screen.getByRole("button", { name: "Record another turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 5_000 });
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"), { timeout: 5_000 });
  await waitFor(() => expect(playbacks).toHaveLength(2), { timeout: 5_000 });
  playbacks[1].ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"), { timeout: 5_000 });

  // Server truth: two turns, four messages, no duplicates.
  const turns = await t.run(async (ctx) => ctx.db.query("tutorTurns").collect());
  const messages = await t.run(async (ctx) => ctx.db.query("messages").collect());
  expect(turns).toHaveLength(2);
  expect(turns.every((turn) => turn.status === "completed")).toBe(true);
  expect(new Set(turns.map((turn) => turn.turnId)).size).toBe(2);
  expect(messages).toHaveLength(4);
  expect(messages.filter((message) => message.role === "learner")).toHaveLength(2);
  expect(messages.filter((message) => message.role === "tutor")).toHaveLength(2);

  // Exactly one provider round trip per stage per turn.
  expect(provider.counts).toEqual({ embeddings: 2, chat: 2, transcriptions: 2, speech: 2 });

  // Both turns render in the server-backed history.
  const history = within(screen.getByRole("region", { name: "Conversation history" }));
  await waitFor(() => expect(history.getAllByText(QUESTION)).toHaveLength(2));
  expect(history.getAllByText((content) => content.includes("Plants turn light into chemical energy"))).toHaveLength(2);

  // Idempotent replay of turn 1: stored result, no provider call, no dupes.
  const firstTurn = turns[0];
  const replay = await a.action(api.tutor.runTurn, { projectId, turnId: firstTurn.turnId, text: QUESTION });
  expect(replay.replayed).toBe(true);
  expect(provider.counts.chat).toBe(2);
  expect(provider.counts.embeddings).toBe(2);
  const after = await t.run(async (ctx) => ctx.db.query("messages").collect());
  expect(after).toHaveLength(4);
  expect(firstTurn.turnId.length).toBeGreaterThan(0);
}, 30_000);
