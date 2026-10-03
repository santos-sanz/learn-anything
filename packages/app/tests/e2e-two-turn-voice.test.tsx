// @vitest-environment jsdom
import { convexTest } from "convex-test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api } from "../../api/convex/_generated/api.js";
import schema from "../../api/convex/schema.js";
import { installAuthTestEnv, TEST_ISSUER } from "../../api/tests/helpers/authEnv.js";
import { embeddingResponse } from "../../api/tests/helpers/embeddingProvider.js";
import { SpokenConversation } from "../src/SpokenConversation.js";
import { makeConvexConversationBackend } from "../src/data/conversation.js";
import { browserTurnEnvironment } from "../src/environments.js";
import { requestTtsAudio } from "../src/ttsClient.js";
import type { ResponsePlayerEnvironment } from "../src/playerController.js";
import type { TurnEnvironment } from "../src/turnController.js";
import { QUESTION, captureHarness, fakePlayback } from "./helpers/voiceConversation.js";

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

// Synthetic offline credentials only; never a real provider key.
process.env.NAN_API_KEY = "synthetic-test-key";
process.env.NAN_DEPLOYER_ID = "learner-a";
process.env.TUTOR_RETRY_BASE_MS = "0";

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

const ANSWER = "Plants convert light into chemical energy [1].";
const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });

type ProviderCounts = { embeddings: number; chat: number; transcriptions: number; speech: number };
let counts: ProviderCounts;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  counts = { embeddings: 0, chat: 0, transcriptions: 0, speech: 0 };
  // One deterministic offline provider: no live call can leave this process.
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { input?: unknown }) : null;
    if (url.endsWith("/embeddings")) {
      counts.embeddings += 1;
      return embeddingResponse(body?.input ?? []);
    }
    if (url.endsWith("/chat/completions")) {
      counts.chat += 1;
      const encoder = new TextEncoder();
      const pieces = ANSWER.match(/.{1,16}/gs) ?? [];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const piece of pieces) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    if (url.endsWith("/audio/transcriptions")) {
      counts.transcriptions += 1;
      return Response.json({ text: QUESTION, language: "en", duration: 1.5 });
    }
    if (url.endsWith("/audio/speech")) {
      counts.speech += 1;
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    throw new Error(`offline voice test attempted an unexpected provider call: ${url}`);
  }) as typeof globalThis.fetch;
  window.location.hash = "";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NAN_API_KEY;
  delete process.env.NAN_DEPLOYER_ID;
  delete process.env.TUTOR_RETRY_BASE_MS;
  cleanup();
});

function stageResult(stage: string): string | null {
  const labels: Record<string, string> = {
    listening: "Listening",
    transcribing: "Transcribing",
    generating: "Retrieving & generating",
    speaking: "Speaking",
    ready: "Ready",
  };
  return screen.getByText(labels[stage]).closest("li")?.querySelector(".stage-result")?.textContent ?? null;
}

test("two spoken turns complete end to end through the real STT, tutor and TTS routes without duplicates", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("learner-a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Voice project" });

  // Ports bound to the same authenticated instance: the UI reaches the real
  // functions (identity re-derived server-side on every call).
  // convex-test's fetch takes root-relative paths and raw bytes; jsdom's Blob
  // body is unwrapped here, exactly like the real request would send it.
  const guardedFetch = async (input: string, init?: RequestInit) => {
    const body = init?.body;
    const normalized = body instanceof Blob ? { ...init, body: new Uint8Array(await body.arrayBuffer()) } : init;
    return a.fetch(input, normalized);
  };
  const backend = makeConvexConversationBackend(a as unknown as Parameters<typeof makeConvexConversationBackend>[0]);
  const httpCapture = browserTurnEnvironment({ siteUrl: "", getToken: () => "synthetic-test-token", fetchImpl: guardedFetch });
  const device = captureHarness().env;
  const capture: TurnEnvironment = { ...device, transcribe: httpCapture.transcribe, translateAudio: httpCapture.translateAudio };
  const playbacks: ReturnType<typeof fakePlayback>[] = [];
  const playback: ResponsePlayerEnvironment = {
    fetchAudio: ({ projectId: target, turnId, language, voice, signal }) =>
      requestTtsAudio({ siteUrl: "", token: "synthetic-test-token", projectId: target, turnId, language, voice, signal, fetchImpl: guardedFetch }),
    createPlayback: async () => {
      const playback = fakePlayback();
      playbacks.push(playback);
      return playback;
    },
  };

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
  expect(counts).toEqual({ embeddings: 2, chat: 2, transcriptions: 2, speech: 2 });

  // Both turns render in the server-backed history.
  const history = within(screen.getByRole("region", { name: "Conversation history" }));
  await waitFor(() => expect(history.getAllByText(QUESTION)).toHaveLength(2));
  expect(history.getAllByText((content) => content.includes("Plants convert light into chemical energy"))).toHaveLength(2);

  // Idempotent replay of turn 1: stored result, no provider call, no dupes.
  const firstTurn = turns[0];
  const replay = await a.action(api.tutor.runTurn, { projectId, turnId: firstTurn.turnId, text: QUESTION });
  expect(replay.replayed).toBe(true);
  expect(counts.chat).toBe(2);
  const after = await t.run(async (ctx) => ctx.db.query("messages").collect());
  expect(after).toHaveLength(4);

  // Replay cost nothing extra: no embeddings, no chat, no new rows.
  expect(counts.embeddings).toBe(2);
  expect(firstTurn.turnId.length).toBeGreaterThan(0);
}, 30_000);
