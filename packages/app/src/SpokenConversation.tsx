import { useAuthToken } from "@convex-dev/auth/react";
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

import { resolveConvexSiteUrl, type TurnLanguage } from "./audioCapture.js";
import { ConversationHistory } from "./ConversationHistory.js";
import { ConversationStageTrack } from "./ConversationStageTrack.js";
import { ConversationController, createConversationController } from "./conversationController.js";
import type { ConversationState } from "./conversationState.js";
import type { ConversationBackend } from "./data/conversation.js";
import { requestTextTranslation } from "./translationClient.js";
import {
  browserPlayerEnvironment,
  browserTurnEnvironment,
  conversationTransport,
} from "./environments.js";
import { ResponsePlayer } from "./ResponsePlayer.js";
import type { ResponsePlayerEnvironment } from "./playerController.js";
import { TurnCapturePanel } from "./TurnCapturePanel.js";
import type { TurnEnvironment } from "./turnController.js";
import type { TurnAction } from "./turnState.js";
import {
  initialTextTranslationState,
  reduceTextTranslation,
  type TranslationLanguage,
} from "./translationState.js";

const SPEECH_LANGUAGE_LABELS: Record<string, string> = { en: "English", es: "Spanish" };

export type SpokenConversationProps = {
  projectId: string;
  siteUrl?: string | undefined;
  /**
   * S14/S16 port. When omitted the panel keeps the capture-only S15/S18
   * behaviour (no tutor turn) — used by tests that only exercise recording.
   */
  conversation?: ConversationBackend | undefined;
  /** Injected capture environment (tests/previews); production uses the browser. */
  capture?: TurnEnvironment | undefined;
  /** Injected playback environment (tests/previews); production uses the browser. */
  playback?: ResponsePlayerEnvironment | undefined;
  /** Test/preview hook: receives the machine once, before the first restore. */
  onControllerReady?: ((controller: ConversationController) => void) | undefined;
};

/**
 * S17 container: hosts one `ConversationController` for a project and renders
 * the explicit spoken-conversation machine — the always-visible stage track
 * with its retry/cancel action bar, the S15 capture panel, the S16 response
 * player, and the server-owned transcript/citation history that survives a
 * reconnect. Translation actions (S18) keep their panel-level flow: only the
 * `transcribe` action continues into retrieval/generation and speech.
 */
export function SpokenConversation({ projectId, siteUrl, conversation, capture, playback, onControllerReady }: SpokenConversationProps) {
  const token = useAuthToken();
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const controllerRef = useRef<ConversationController | null>(null);
  if (controllerRef.current === null) {
    const transport = conversationTransport(siteUrl, () => tokenRef.current);
    controllerRef.current = createConversationController({
      env: {
        capture: capture ?? browserTurnEnvironment(transport),
        conversation: conversation ?? null,
        playback: playback ?? (conversation === undefined ? null : browserPlayerEnvironment(transport)),
      },
      projectId,
    });
  }
  const controller = controllerRef.current;
  const state: ConversationState = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  const [language, setLanguageState] = useState<TurnLanguage>("en");
  const [action, setActionState] = useState<TurnAction | null>(null);
  const [target, setTargetState] = useState<TranslationLanguage>("en");
  const [textTranslation, dispatchText] = useReducer(reduceTextTranslation, undefined, initialTextTranslationState);
  const translationAbort = useRef<AbortController | null>(null);
  const announced = useRef(false);

  useEffect(() => {
    if (!announced.current) {
      announced.current = true;
      onControllerReady?.(controller);
    }
    void controller.restore();
    return () => {
      controller.dispose();
      translationAbort.current?.abort();
    };
  }, [controller, onControllerReady]);

  // A finished recording seeds the text source once per turn; later events
  // from the same turn can never overwrite text the learner has edited.
  useEffect(() => {
    if (state.capture.phase === "transcript") {
      dispatchText({
        type: "SEED_ORIGINAL",
        text: state.capture.text,
        source: state.capture.detectedLanguage,
        turnId: state.capture.turnId,
      });
    }
  }, [state.capture]);

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

  const handleConversationAction = useCallback(
    (kind: string) => {
      switch (kind) {
        case "cancel-turn":
          controller.cancelTurn();
          return;
        case "retry":
          controller.retry();
          return;
        case "discard":
          controller.discard();
          return;
        case "stop":
          controller.stopSpeaking();
          return;
        case "new-turn":
          void controller.start();
          return;
        case "retry-history":
          controller.retryHistory();
          return;
        default:
          return;
      }
    },
    [controller],
  );

  const speechOptions = state.speech?.options ?? null;
  const speechLanguage = state.speech?.language ?? "en";
  const languageOptions = (speechOptions?.languages ?? []).map((code) => ({
    code,
    label: SPEECH_LANGUAGE_LABELS[code] ?? code,
  }));

  return (
    <section className="conversation" aria-labelledby="conversation-heading">
      <h2 id="conversation-heading">Speak with your tutor</h2>
      <p className="screen-intro">
        Record one turn at a time: it is transcribed, grounded in your documents, answered and spoken. Every stage is shown below
        with a cancel while it runs and a retry if it fails.
      </p>

      <ConversationStageTrack state={state} onAction={handleConversationAction} />

      <TurnCapturePanel
        state={state.capture}
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

      {state.player !== null && state.response !== null && (
        <ResponsePlayer
          transcript={state.response.text}
          state={state.player}
          language={speechLanguage}
          languages={languageOptions}
          onLanguageChange={controller.setSpeechLanguage}
          onPlay={controller.play}
          onPause={controller.pause}
          onResume={controller.resume}
          onStop={controller.stopSpeaking}
          onRetry={controller.retry}
        />
      )}

      {conversation !== undefined && (
        <ConversationHistory projectId={projectId} history={state.history} droppedCitations={state.history.status === "ready" ? state.history.droppedCitations : 0} onRetry={controller.retryHistory} />
      )}
    </section>
  );
}
