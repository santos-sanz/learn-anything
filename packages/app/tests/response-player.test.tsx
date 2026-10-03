// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";

import type { SpeechOptions, TutorBackend, TutorResponseSummary, TutorTurnSummary } from "../src/data/tutor.js";
import type { PlayerPlayback, ResponsePlayerEnvironment } from "../src/playerController.js";
import { TutorResponseSection } from "../src/TutorResponseSection.js";
import type { TtsFailureCode, TtsResult } from "../src/ttsClient.js";

afterEach(cleanup);

const TUTOR_TEXT = "Sunlight becomes chemical energy [1]. Chlorophyll absorbs it [2].";

const SPEECH_OPTIONS: SpeechOptions = {
  model: "kokoro",
  format: "mp3",
  languages: ["en", "es"],
  voices: [
    { id: "af_heart", language: "en", label: "English (af_heart)" },
    { id: "ef_dora", language: "es", label: "Spanish (ef_dora)" },
  ],
  maxTextChars: 20_000,
};

const AUDIO = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" });

function ttsOk(): TtsResult {
  return { ok: true, audio: AUDIO, contentType: "audio/mpeg" };
}

function ttsFail(code: TtsFailureCode, extra: Partial<Extract<TtsResult, { ok: false }>> = {}): TtsResult {
  return { ok: false, code, message: "", retryAfterMs: null, supportedVoices: null, supportedLanguages: null, ...extra };
}

type FetchRecord = { projectId: string; turnId: string; language: string; voice: string | null; aborted: boolean };

type Controls = {
  mode: "auto" | "manual";
  result: TtsResult | (() => TtsResult);
  playBehaviour: "ok" | "blocked-once" | "error-once" | "always-error";
  fetches: FetchRecord[];
  playbacks: FakePlayback[];
  playAttempts: number;
  pending: ((result: TtsResult) => void) | null;
};

class FakePlayback implements PlayerPlayback {
  public playCalls = 0;
  public pauseCalls = 0;
  public disposeCalls = 0;
  public onEnded: (() => void) | null = null;
  public onError: (() => void) | null = null;

  public constructor(private readonly controls: Controls) {}

  public async play(): Promise<void> {
    this.playCalls += 1;
    this.controls.playAttempts += 1;
    const attempt = this.controls.playAttempts;
    if (this.controls.playBehaviour === "always-error") throw new Error("media element failed");
    if (this.controls.playBehaviour === "blocked-once" && attempt === 1) {
      throw new DOMException("play() was blocked by autoplay policy", "NotAllowedError");
    }
    if (this.controls.playBehaviour === "error-once" && attempt === 1) throw new Error("media element failed");
  }

  public pause(): void {
    this.pauseCalls += 1;
  }

  public dispose(): void {
    this.disposeCalls += 1;
  }
}

function fakeEnvironment(mode: Controls["mode"] = "auto"): { env: ResponsePlayerEnvironment; controls: Controls } {
  const controls: Controls = {
    mode,
    result: ttsOk,
    playBehaviour: "ok",
    fetches: [],
    playbacks: [],
    playAttempts: 0,
    pending: null,
  };
  const env: ResponsePlayerEnvironment = {
    fetchAudio(request) {
      const record: FetchRecord = {
        projectId: request.projectId,
        turnId: request.turnId,
        language: request.language,
        voice: request.voice,
        aborted: request.signal.aborted,
      };
      controls.fetches.push(record);
      if (controls.mode === "manual") {
        return new Promise<TtsResult>((resolve) => {
          controls.pending = (result) => {
            record.aborted = request.signal.aborted;
            resolve(result);
          };
        });
      }
      return Promise.resolve(typeof controls.result === "function" ? controls.result() : controls.result);
    },
    async createPlayback() {
      const playback = new FakePlayback(controls);
      controls.playbacks.push(playback);
      return playback;
    },
  };
  return { env, controls };
}

type BackendState = {
  response: TutorResponseSummary | null;
  turn: TutorTurnSummary | null;
  failLoad: boolean;
  cancels: string[];
};

function fakeBackend(): { backend: TutorBackend; state: BackendState } {
  const state: BackendState = {
    response: { turnId: "turn-1", text: TUTOR_TEXT, createdAt: 1_760_000_000_000 },
    turn: null,
    failLoad: false,
    cancels: [],
  };
  const backend: TutorBackend = {
    async latestResponse() {
      if (state.failLoad) throw new Error("fixture load failed");
      return state.response;
    },
    async latestTurn() {
      return state.turn;
    },
    async speechOptions() {
      return SPEECH_OPTIONS;
    },
    async cancelTurn(_projectId, turnId) {
      state.cancels.push(turnId);
    },
  };
  return { backend, state };
}

function transcript(): HTMLElement | null {
  return document.querySelector(".player-transcript");
}

/** Lets pending promise chains settle so a stale continuation would have run by now. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

test("play, pause, resume and stop drive one response with the transcript always visible", async () => {
  const user = userEvent.setup();
  const { env, controls } = fakeEnvironment();
  const { backend } = fakeBackend();

  render(<TutorResponseSection projectId="p1" backend={backend} environment={env} />);

  expect(await screen.findByText("Playing.")).toBeTruthy();
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);
  expect(screen.getByLabelText("Speech language")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel turn" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Pause" }));
  expect(screen.getByText("Paused.")).toBeTruthy();
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);

  await user.click(screen.getByRole("button", { name: "Resume" }));
  expect(await screen.findByText("Playing.")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(screen.getByText("Ready to play this response.")).toBeTruthy();

  // The bytes are cached per language, so a replay does not re-synthesize.
  await user.click(screen.getByRole("button", { name: "Play audio" }));
  expect(await screen.findByText("Playing.")).toBeTruthy();
  expect(controls.fetches).toHaveLength(1);
  expect(controls.playbacks).toHaveLength(2);
  expect(controls.playbacks[1].pauseCalls).toBe(0);
});

test("blocked autoplay lands in a handled state and the Play audio gesture starts it", async () => {
  const user = userEvent.setup();
  const { env, controls } = fakeEnvironment();
  controls.playBehaviour = "blocked-once";
  const { backend } = fakeBackend();

  render(<TutorResponseSection projectId="p1" backend={backend} environment={env} />);

  const blocked = await screen.findByRole("alert");
  expect(blocked.textContent).toContain("Automatic playback was blocked by your browser");
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Play audio" }));
  expect(await screen.findByText("Playing.")).toBeTruthy();
  expect(controls.playAttempts).toBe(2);
});

test("a synthesis failure keeps the complete transcript and Retry recovers", async () => {
  const user = userEvent.setup();
  const { env, controls } = fakeEnvironment();
  controls.result = ttsFail("provider-unavailable");
  const { backend } = fakeBackend();

  render(<TutorResponseSection projectId="p1" backend={backend} environment={env} />);

  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain("The speech service did not respond in time.");
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

  controls.result = ttsOk;
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Playing.")).toBeTruthy();
  expect(controls.fetches).toHaveLength(2);
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);
});

test("an unsupported voice fails with the configured-voice explanation, never a silent fallback", async () => {
  const user = userEvent.setup();
  const { env, controls } = fakeEnvironment();
  controls.result = ttsFail("unsupported-voice", {
    supportedVoices: ["af_heart", "ef_dora"],
    supportedLanguages: ["en", "es"],
    message: "This voice is not configured on the server. Pick one of the available voices and try again.",
  });
  const { backend } = fakeBackend();

  render(<TutorResponseSection projectId="p1" backend={backend} environment={env} />);

  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain("This voice is not configured on the server.");
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(controls.playbacks).toHaveLength(0);

  controls.result = ttsOk;
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Playing.")).toBeTruthy();
});

test("a browser playback failure keeps the transcript and Retry recovers", async () => {
  const user = userEvent.setup();
  const { env, controls } = fakeEnvironment();
  controls.playBehaviour = "error-once";
  const { backend } = fakeBackend();

  render(<TutorResponseSection projectId="p1" backend={backend} environment={env} />);

  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain("Audio playback failed in the browser.");
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);

  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Playing.")).toBeTruthy();
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);
});

test("anonymous and cross-user denials stay typed and never blank the response", async () => {
  const user = userEvent.setup();
  const { env, controls } = fakeEnvironment();
  controls.result = ttsFail("unauthenticated");
  const { backend } = fakeBackend();

  render(<TutorResponseSection projectId="p1" backend={backend} environment={env} />);

  let failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain("Your session has expired.");
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);

  controls.result = ttsFail("not-found");
  await user.click(screen.getByRole("button", { name: "Retry" }));
  failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain("This response is no longer available for audio playback.");
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);
  expect(controls.playbacks).toHaveLength(0);
});

test("cancelling the tutor turn stops playback and rejects audio that arrives afterwards", async () => {
  const user = userEvent.setup();
  const { env, controls } = fakeEnvironment("manual");
  const { backend, state } = fakeBackend();
  state.turn = { turnId: "turn-2", status: "running", createdAt: 2 };

  render(<TutorResponseSection projectId="p1" backend={backend} environment={env} />);

  expect(await screen.findByText("Loading audio…")).toBeTruthy();
  const cancel = await screen.findByRole("button", { name: "Cancel turn" });

  await user.click(cancel);
  expect(state.cancels).toEqual(["turn-2"]);
  expect(await screen.findByText(/Turn cancelled\. Playback stopped/)).toBeTruthy();
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);

  // The provider answer for the cancelled turn lands late: it must be dropped.
  controls.pending?.(ttsOk());
  await flush();
  expect(controls.fetches[0].aborted).toBe(true);
  expect(controls.playbacks).toHaveLength(0);
  expect(screen.getByText(/Turn cancelled\. Playback stopped/)).toBeTruthy();
  expect(screen.queryByText("Playing.")).toBeNull();
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);
});

test("stopping while audio is still loading discards bytes that arrive late", async () => {
  const user = userEvent.setup();
  const { env, controls } = fakeEnvironment("manual");
  const { backend } = fakeBackend();

  render(<TutorResponseSection projectId="p1" backend={backend} environment={env} />);

  expect(await screen.findByText("Loading audio…")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(screen.getByText("Ready to play this response.")).toBeTruthy();

  controls.pending?.(ttsOk());
  await flush();
  expect(controls.fetches[0].aborted).toBe(true);
  expect(controls.playbacks).toHaveLength(0);
  expect(screen.getByText("Ready to play this response.")).toBeTruthy();
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);
});

test("the language picker only offers configured languages and refetches in that language", async () => {
  const user = userEvent.setup();
  const { env, controls } = fakeEnvironment();
  const { backend } = fakeBackend();

  render(<TutorResponseSection projectId="p1" backend={backend} environment={env} />);
  expect(await screen.findByText("Playing.")).toBeTruthy();
  expect(controls.fetches[0]).toMatchObject({ language: "en", voice: "af_heart" });

  await user.selectOptions(screen.getByLabelText("Speech language"), "es");
  expect(screen.getByText("Ready to play this response.")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Play audio" }));
  expect(await screen.findByText("Playing.")).toBeTruthy();
  expect(controls.fetches[1]).toMatchObject({ language: "es", voice: "ef_dora", turnId: "turn-1" });
});

test("a failed response load shows an actionable error and recovers on retry", async () => {
  const user = userEvent.setup();
  const { env } = fakeEnvironment();
  const { backend, state } = fakeBackend();
  state.failLoad = true;

  render(<TutorResponseSection projectId="p1" backend={backend} environment={env} />);

  expect((await screen.findByRole("alert")).textContent).toBe("The tutor response could not be loaded.");
  expect(transcript()).toBeNull();

  state.failLoad = false;
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Playing.")).toBeTruthy();
  expect(transcript()?.textContent).toBe(TUTOR_TEXT);
});

test("a project without tutor responses explains the empty state", async () => {
  const { env } = fakeEnvironment();
  const { backend, state } = fakeBackend();
  state.response = null;

  render(<TutorResponseSection projectId="p1" backend={backend} environment={env} />);

  expect(await screen.findByText(/No tutor response yet/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Play audio" })).toBeNull();
});
