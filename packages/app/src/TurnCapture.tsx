import { useAuthToken } from "@convex-dev/auth/react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { resolveConvexSiteUrl, type TurnLanguage } from "./audioCapture.js";
import { TurnCapturePanel } from "./TurnCapturePanel.js";
import { requestTranscription } from "./transcribeClient.js";
import { TurnController, type CaptureRecording, type CaptureSubscription, type TurnEnvironment } from "./turnController.js";

function browserTurnEnvironment(siteUrl: string, getToken: () => string | null): TurnEnvironment {
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
      requestTranscription({ siteUrl, token: getToken(), projectId, language, turnId, audio, signal }),
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

export type TurnCaptureProps = {
  projectId: string;
  siteUrl?: string | undefined;
};

/** Container: owns the controller and the browser environment for one project. */
export function TurnCapture({ projectId, siteUrl }: TurnCaptureProps) {
  const token = useAuthToken();
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const controllerRef = useRef<TurnController | null>(null);
  if (controllerRef.current === null) {
    const resolvedSiteUrl = resolveConvexSiteUrl(import.meta.env.VITE_CONVEX_URL, siteUrl);
    controllerRef.current = new TurnController({
      env: browserTurnEnvironment(resolvedSiteUrl, () => tokenRef.current),
      projectId,
    });
  }
  const controller = controllerRef.current;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [language, setLanguageState] = useState<TurnLanguage>("en");

  const handleLanguageChange = useCallback(
    (next: TurnLanguage) => {
      setLanguageState(next);
      controller.setLanguage(next);
    },
    [controller],
  );

  return (
    <TurnCapturePanel
      state={state}
      language={language}
      onLanguageChange={handleLanguageChange}
      onStart={() => void controller.start()}
      onStop={controller.stopRecording}
      onCancel={controller.cancel}
      onEditTranscript={controller.editTranscript}
    />
  );
}
