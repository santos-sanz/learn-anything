import { useAuthToken } from "@convex-dev/auth/react";
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

import { resolveConvexSiteUrl, type TurnLanguage } from "./audioCapture.js";
import { TurnCapturePanel } from "./TurnCapturePanel.js";
import { requestTranscription } from "./transcribeClient.js";
import { requestAudioTranslation, requestTextTranslation } from "./translationClient.js";
import {
  initialTextTranslationState,
  reduceTextTranslation,
  type TranslationLanguage,
} from "./translationState.js";
import {
  TurnController,
  type CaptureRecording,
  type CaptureSubscription,
  type TurnEnvironment,
} from "./turnController.js";
import type { TurnAction } from "./turnState.js";

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
    translateAudio: ({ audio, projectId, target, turnId, signal }) =>
      requestAudioTranslation({ siteUrl, token: getToken(), projectId, turnId, target, audio, signal }),
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

/** Container: owns the controller, the explicit action choice and the browser environment for one project. */
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
  const [action, setActionState] = useState<TurnAction | null>(null);
  const [target, setTargetState] = useState<TranslationLanguage>("en");
  const [textTranslation, dispatchText] = useReducer(reduceTextTranslation, undefined, initialTextTranslationState);
  const translationAbort = useRef<AbortController | null>(null);

  useEffect(() => () => translationAbort.current?.abort(), []);

  // A finished recording seeds the text source once per turn; later events from
  // the same turn can never overwrite text the learner has edited.
  useEffect(() => {
    if (state.phase === "transcript") {
      dispatchText({ type: "SEED_ORIGINAL", text: state.text, source: state.detectedLanguage, turnId: state.turnId });
    }
  }, [state]);

  const handleLanguageChange = useCallback(
    (next: TurnLanguage) => {
      setLanguageState(next);
      controller.setLanguage(next);
    },
    [controller],
  );

  const handleActionChange = useCallback(
    (next: TurnAction) => {
      setActionState(next);
      controller.setAction(next);
    },
    [controller],
  );

  const handleTargetChange = useCallback(
    (next: TranslationLanguage) => {
      setTargetState(next);
      controller.setTarget(next);
    },
    [controller],
  );

  const handleTranslateText = useCallback(() => {
    const abort = new AbortController();
    translationAbort.current?.abort();
    translationAbort.current = abort;
    dispatchText({ type: "REQUEST" });
    void requestTextTranslation({
      siteUrl: resolveConvexSiteUrl(import.meta.env.VITE_CONVEX_URL, siteUrl),
      token: tokenRef.current,
      projectId,
      text: textTranslation.original,
      source: textTranslation.source,
      target,
      signal: abort.signal,
    }).then((result) => {
      if (abort.signal.aborted) return;
      translationAbort.current = null;
      if (result.ok) {
        dispatchText({ type: "SUCCEEDED", target: result.target, translation: result.translation, unchanged: result.unchanged });
      } else {
        dispatchText({ type: "FAILED", code: result.code, retryAfterMs: result.retryAfterMs });
      }
    });
  }, [projectId, siteUrl, target, textTranslation.original, textTranslation.source]);

  return (
    <TurnCapturePanel
      state={state}
      action={action}
      onActionChange={handleActionChange}
      language={language}
      onLanguageChange={handleLanguageChange}
      target={target}
      onTargetChange={handleTargetChange}
      onStart={() => void controller.start()}
      onStop={controller.stopRecording}
      onCancel={controller.cancel}
      onEditTranscript={controller.editTranscript}
      textTranslation={textTranslation}
      onEditSourceText={(text) => dispatchText({ type: "EDIT_ORIGINAL", text })}
      onSourceLanguageChange={(source) => dispatchText({ type: "SET_SOURCE", source })}
      onTranslateText={handleTranslateText}
      onClearTranslation={() => dispatchText({ type: "CLEAR_RESULT" })}
    />
  );
}
