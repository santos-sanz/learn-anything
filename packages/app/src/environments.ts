import { resolveConvexSiteUrl } from "./audioCapture.js";
import type { PlayerPlayback, ResponsePlayerEnvironment } from "./playerController.js";
import { requestTranscription } from "./transcribeClient.js";
import { requestAudioTranslation } from "./translationClient.js";
import type { CaptureRecording, CaptureSubscription, TurnEnvironment } from "./turnController.js";
import { requestTtsAudio } from "./ttsClient.js";

/**
 * Browser environments for the S17 conversation machine. Everything the
 * machine touches — microphone, STT/TTS HTTP routes, playback — arrives
 * through these builders, so tests and DEV previews inject deterministic
 * fakes (or the in-process convex-test fetch) without touching the machine.
 */

export type SpeechTransport = {
  siteUrl: string;
  getToken: () => string | null;
  /** Injected by tests/previews; production uses the browser `fetch`. */
  fetchImpl?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
};

export type CaptureTransport = SpeechTransport;

/**
 * Real MediaRecorder capture plus the S15 transcription / S18 audio-translation
 * HTTP routes. Test callers spread over this to replace only the device layer
 * (`startMicrophone`, `readPeakLevel`, support probes) while keeping the real
 * request/URL/status mapping on the wire.
 */
export function browserTurnEnvironment(transport: CaptureTransport): TurnEnvironment {
  const { siteUrl, getToken, fetchImpl } = transport;
  const hasCaptureSupport = (): boolean =>
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined";

  return {
    hasCaptureSupport,
    isTypeSupported: (mimeType) => hasCaptureSupport() && MediaRecorder.isTypeSupported(mimeType),
    startMicrophone: async (mimeType, subscription: CaptureSubscription): Promise<CaptureRecording> => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        subscription.onAudio(new Blob(chunks, { type: recorder.mimeType === "" ? mimeType : recorder.mimeType }));
        chunks.length = 0;
      };
      recorder.onerror = (event) => subscription.onError((event as ErrorEvent).error?.name);
      recorder.start();
      return {
        stop: () => {
          if (recorder.state !== "inactive") recorder.stop();
        },
        stopTracks: () => {
          for (const track of stream.getTracks()) track.stop();
        },
      };
    },
    readPeakLevel: async (audio) => {
      const context = new AudioContext();
      try {
        const decoded = await context.decodeAudioData(await audio.arrayBuffer());
        const samples = decoded.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const value = Math.abs(samples[i]);
          if (value > peak) peak = value;
        }
        return peak;
      } finally {
        void context.close();
      }
    },
    transcribe: ({ audio, projectId, language, turnId, signal }) =>
      requestTranscription({
        siteUrl,
        token: getToken(),
        projectId,
        language,
        turnId,
        audio,
        signal,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      }),
    translateAudio: ({ audio, projectId, target, turnId, signal }) =>
      requestAudioTranslation({
        siteUrl,
        token: getToken(),
        projectId,
        turnId,
        target,
        audio,
        signal,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      }),
    newTurnId: () =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    now: () => Date.now(),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancelSchedule: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    discardAudio: () => {
      // The blob reference is dropped here; audio is never stored or logged.
    },
  };
}

/**
 * Real browser playback over an in-memory object URL. The bytes were fetched
 * through the authenticated route and live only in this tab: nothing is
 * written to storage and no URL is persisted or logged.
 */
export function createBrowserPlayback(audio: Blob): Promise<PlayerPlayback> {
  const url = URL.createObjectURL(audio);
  const element = new Audio();
  return new Promise<PlayerPlayback>((resolve, reject) => {
    let settled = false;
    const handle: PlayerPlayback = {
      async play() {
        await element.play();
      },
      pause() {
        element.pause();
      },
      dispose() {
        element.pause();
        element.removeAttribute("src");
        element.load();
        URL.revokeObjectURL(url);
      },
      onEnded: null,
      onError: null,
    };
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      element.removeEventListener("canplay", ready);
      element.removeEventListener("error", broken);
      if (failed) {
        URL.revokeObjectURL(url);
        reject(new Error("The browser could not load this audio."));
      } else {
        resolve(handle);
      }
    };
    const ready = () => finish(false);
    const broken = () => finish(true);
    element.addEventListener("canplay", ready, { once: true });
    element.addEventListener("error", broken, { once: true });
    element.addEventListener("ended", () => handle.onEnded?.());
    element.addEventListener("error", () => handle.onError?.());
    element.preload = "auto";
    element.src = url;
    element.load();
  });
}

/** S16 TTS fetch + browser playback for the conversation's speaking stage. */
export function browserPlayerEnvironment(transport: SpeechTransport): ResponsePlayerEnvironment {
  const { siteUrl, getToken, fetchImpl } = transport;
  return {
    fetchAudio: ({ projectId, turnId, language, voice, signal }) =>
      requestTtsAudio({
        siteUrl,
        token: getToken(),
        projectId,
        turnId,
        language,
        voice,
        signal,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      }),
    createPlayback: createBrowserPlayback,
  };
}

/** Resolves the `.convex.site` HTTP origin once for every transport. */
export function conversationTransport(siteUrl: string | undefined, getToken: () => string | null): CaptureTransport {
  return {
    siteUrl: resolveConvexSiteUrl(import.meta.env.VITE_CONVEX_URL, siteUrl),
    getToken,
  };
}
