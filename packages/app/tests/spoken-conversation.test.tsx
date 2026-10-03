// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";

import { SpokenConversation } from "../src/SpokenConversation.js";
import type { TranscribeResult } from "../src/transcribeClient.js";
import { ANSWER, PROJECT, QUESTION, captureHarness, memoryBackend, playbackHarness } from "./helpers/voiceConversation.js";

/**
 * S17 stage-visibility and retry/cancel UI: the real components driven by the
 * scripted microphone/port fixtures, asserting that every stage and error is
 * on screen with the controls the acceptance criteria demand.
 */

afterEach(cleanup);

const STAGE_LABELS: Record<string, string> = {
  listening: "Listening",
  transcribing: "Transcribing",
  generating: "Retrieving & generating",
  speaking: "Speaking",
  ready: "Ready",
};

function stageResult(stage: string): string | null {
  const item = screen.getByText(STAGE_LABELS[stage]).closest("li");
  return item?.querySelector(".stage-result")?.textContent ?? null;
}

function historyRegion() {
  return within(screen.getByRole("region", { name: "Conversation history" }));
}

function playerElement(): HTMLElement | null {
  return document.querySelector(".response-player");
}

function renderConversation(store = memoryBackend()) {
  const capture = captureHarness();
  const playback = playbackHarness();
  render(<SpokenConversation projectId={PROJECT} conversation={store.backend} capture={capture.env} playback={playback.env} />);
  return { store, capture, playback };
}

async function pickTranscribeAndRecord(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("radio", { name: /Transcribe speech/ }));
  await user.click(screen.getByRole("button", { name: "Record a turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"));
}

test("every stage is visible with a state word, and the status line follows the pipeline", async () => {
  const user = userEvent.setup();
  const store = memoryBackend();
  const { capture, playback } = renderConversation(store);

  // Before anything runs: all five stages render, ready is the resting step.
  expect(screen.getByRole("list", { name: "Conversation stages" })).toBeTruthy();
  expect(stageResult("ready")).toBe("reached");
  expect(stageResult("listening")).toBe("waiting");
  expect(screen.getByText(/Ready\. Record a turn/)).toBeTruthy();

  // listening: the microphone cycle is the current step.
  await pickTranscribeAndRecord(user);
  expect(stageResult("listening")).toBe("in progress");
  expect(stageResult("transcribing")).toBe("waiting");
  expect(screen.getByText(/Listening: recording your turn/)).toBeTruthy();

  // transcribing: hold the STT round trip so the stage is observable.
  let finishTranscription: ((result: TranscribeResult) => void) | null = null;
  capture.setTranscribe(() => new Promise<TranscribeResult>((resolve) => { finishTranscription = resolve; }));
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("transcribing")).toBe("in progress"));
  expect(screen.getByText(/Transcribing your turn with speech-to-text/)).toBeTruthy();
  expect(stageResult("listening")).toBe("done");

  // generating: retrieval + generation with its own cancel.
  store.hold();
  if (finishTranscription === null) throw new Error("transcribe promise was never created");
  finishTranscription({ ok: true, text: QUESTION, detectedLanguage: "en", durationMs: 1.5, turnId: "turn-1" });
  await waitFor(() => expect(stageResult("generating")).toBe("in progress"));
  expect(screen.getByText(/Retrieving sources and generating the tutor/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel turn" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "New turn" })).toBeTruthy();

  // speaking: the answer renders in the player while speech is the current step.
  store.release();
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"));
  expect(playerElement()?.textContent).toContain(ANSWER);
  expect(screen.getByRole("button", { name: "Stop speaking" })).toBeTruthy();

  // ready: playback finished; the whole path is marked done.
  await waitFor(() => expect(playback.playbacks.length).toBeGreaterThan(0));
  playback.playbacks[0].ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"));
  expect(stageResult("speaking")).toBe("done");
  expect(stageResult("generating")).toBe("done");
  expect(screen.getByText(/Ready\. The answer was spoken/)).toBeTruthy();

  // History shows the stored turn while resting.
  await waitFor(() => expect(historyRegion().getByText(QUESTION)).toBeTruthy());
  expect(historyRegion().getByText(ANSWER)).toBeTruthy();
});

test("a generating failure is an alert with Retry and Discard, and Retry never double-sends", async () => {
  const user = userEvent.setup();
  const store = memoryBackend();
  renderConversation(store);

  store.failNextWith({ ok: false, code: "TURN_TIMEOUT", retryAfterMs: null, ambiguous: false });
  await pickTranscribeAndRecord(user);
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Retry the same turn");
  expect(stageResult("generating")).toBe("failed");
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Discard response" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"));
  // Terminal failure → a fresh id; the failed attempt wrote nothing.
  expect(store.turnIds).toHaveLength(2);
  expect(store.turnIds[1]).not.toBe(store.turnIds[0]);
  expect(store.messages).toHaveLength(2);
  // After Retry the error stage is gone, so Discard is not offered.
  expect(screen.queryByRole("button", { name: "Discard response" })).toBeNull();
});

test("cancel at generating stops the turn, keeps the transcript and returns to ready", async () => {
  const user = userEvent.setup();
  const store = memoryBackend();
  renderConversation(store);

  store.hold();
  await pickTranscribeAndRecord(user);
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("generating")).toBe("in progress"));
  const turnId = store.turnIds[0];
  expect(turnId).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Cancel turn" }));
  await waitFor(() => expect(stageResult("ready")).toBe("reached"));
  expect(store.cancelCalls).toEqual([turnId]);
  expect(screen.getByText(/Turn cancelled\. No answer was written/)).toBeTruthy();
  // The transcript stays editable and the learner can record again.
  expect(screen.getByLabelText("Transcription (editable)")).toBeTruthy();
  store.release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(store.messages).toHaveLength(0);
  expect(stageResult("ready")).toBe("reached");
});

test("stopping speech and starting a NEW turn hides the old answer until the new one lands", async () => {
  const user = userEvent.setup();
  const store = memoryBackend();
  const { playback } = renderConversation(store);

  await pickTranscribeAndRecord(user);
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"));
  expect(playerElement()?.textContent).toContain(ANSWER);
  const firstTurn = store.turnIds[0];

  // New turn while the old answer is still on screen.
  await user.click(screen.getByRole("button", { name: "New turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"));
  // The old response and its player are gone immediately; only history remains.
  expect(playerElement()).toBeNull();
  expect(historyRegion().getByText(ANSWER)).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"));
  expect(store.turnIds).toHaveLength(2);
  expect(store.turnIds[1]).not.toBe(firstTurn);
  expect(playback.playbacks).toHaveLength(2);
  expect(store.messages.filter((message) => message.role === "learner")).toHaveLength(2);
  expect(screen.queryByText(/Turn cancelled/)).toBeNull();
});

test("transcripts and citations stay available while listening", async () => {
  const user = userEvent.setup();
  const store = memoryBackend();
  renderConversation(store);

  // Turn 1 completes and lands in the server-backed history.
  await pickTranscribeAndRecord(user);
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"));
  await waitFor(() => expect(historyRegion().getByText(QUESTION)).toBeTruthy());

  // A second listening cycle must not clear the history panel.
  await user.click(screen.getByRole("button", { name: "New turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"));
  expect(historyRegion().getByText(QUESTION)).toBeTruthy();
  expect(historyRegion().getByText(ANSWER)).toBeTruthy();
  expect(screen.getByRole("region", { name: "Conversation history" })).toBeTruthy();
});
