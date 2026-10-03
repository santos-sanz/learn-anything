import { useAuthToken } from "@convex-dev/auth/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { resolveConvexSiteUrl } from "./audioCapture.js";
import type { SpeechOptions, TutorBackend, TutorResponseSummary, TutorTurnSummary } from "./data/tutor.js";
import { createBrowserPlayback } from "./environments.js";
import { ResponsePlayerController, type ResponsePlayerEnvironment } from "./playerController.js";
import { ResponsePlayer } from "./ResponsePlayer.js";
import { requestTtsAudio } from "./ttsClient.js";

const LANGUAGE_LABELS: Record<string, string> = { en: "English", es: "Spanish" };

type SectionData =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; response: TutorResponseSummary | null; options: SpeechOptions };

export type TutorResponseSectionProps = {
  projectId: string;
  backend: TutorBackend;
  siteUrl?: string | undefined;
  /** Injected in tests and previews; production uses the browser environment. */
  environment?: ResponsePlayerEnvironment | undefined;
};

function voiceForLanguage(options: SpeechOptions, language: string): string | null {
  return options.voices.find((voice) => voice.language === language)?.id ?? null;
}

/** Player host: one controller per response turn, auto-starting playback on arrival. */
function ResponsePlayerHost({
  projectId,
  response,
  options,
  environment,
  onRegisterCancel,
  cancelBusy,
}: {
  projectId: string;
  response: TutorResponseSummary;
  options: SpeechOptions;
  environment: ResponsePlayerEnvironment;
  onRegisterCancel: (cancel: (() => void) | null) => void;
  cancelBusy: boolean;
}) {
  const [language, setLanguage] = useState(options.languages[0] ?? "en");
  const controllerRef = useRef<ResponsePlayerController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new ResponsePlayerController({
      env: environment,
      projectId,
      turnId: response.turnId,
      language,
      voice: voiceForLanguage(options, language),
    });
  }
  const controller = controllerRef.current;

  useEffect(() => {
    onRegisterCancel(controller.cancel);
    // A tutor response may autoplay; a browser that blocks it lands in the
    // `autoplay-blocked` state, and the Play audio button's click is the
    // user gesture that starts it.
    void controller.autoStart();
    return () => {
      onRegisterCancel(null);
      controller.dispose();
    };
  }, [controller, onRegisterCancel]);

  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  const handleLanguageChange = (next: string) => {
    setLanguage(next);
    controller.setLanguage(next, voiceForLanguage(options, next));
  };

  return (
    <ResponsePlayer
      transcript={response.text}
      state={state}
      language={language}
      languages={options.languages.map((code) => ({ code, label: LANGUAGE_LABELS[code] ?? code }))}
      onLanguageChange={handleLanguageChange}
      onPlay={() => void controller.play()}
      onPause={controller.pause}
      onResume={() => void controller.resume()}
      onStop={controller.stop}
      onRetry={() => void controller.retry()}
      cancelBusy={cancelBusy}
    />
  );
}

/**
 * S16 response surface: the complete tutor transcript plus the play/pause/stop
 * player, the configured speech-language picker and the S14 cancel action for
 * an in-flight turn. Loading and failure states never replace the transcript —
 * a failed audio fetch keeps the text visible with a Retry action.
 */
export function TutorResponseSection({ projectId, backend, siteUrl, environment }: TutorResponseSectionProps) {
  const [data, setData] = useState<SectionData>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [turn, setTurn] = useState<TutorTurnSummary | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const playerCancel = useRef<(() => void) | null>(null);
  const token = useAuthToken();
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    let active = true;
    setData({ status: "loading" });
    Promise.all([backend.latestResponse(projectId), backend.latestTurn(projectId), backend.speechOptions()])
      .then(([response, latest, options]) => {
        if (!active) return;
        setData({ status: "ready", response, options });
        setTurn(latest);
      })
      .catch(() => {
        if (active) setData({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [backend, projectId, attempt]);

  const registerCancel = useCallback((cancel: (() => void) | null) => {
    playerCancel.current = cancel;
  }, []);

  const handleCancelTurn = useCallback(async () => {
    if (turn === null) return;
    // Stopping playback first means a response that arrives after the cancel
    // can never start playing, even if the mutation answer is still pending.
    playerCancel.current?.();
    setCancelBusy(true);
    try {
      await backend.cancelTurn(projectId, turn.turnId);
      setTurn((current) => (current !== null && current.turnId === turn.turnId ? { ...current, status: "cancelled" } : current));
    } catch {
      // The player-side stop already happened; the turn row keeps its own
      // server state and the next reload shows the authoritative status.
    } finally {
      setCancelBusy(false);
    }
  }, [backend, projectId, turn]);

  const resolvedSiteUrl = useMemo(
    () => resolveConvexSiteUrl(import.meta.env.VITE_CONVEX_URL, siteUrl),
    [siteUrl],
  );

  const defaultEnvironment = useMemo<ResponsePlayerEnvironment | null>(() => {
    if (environment !== undefined) return environment;
    if (resolvedSiteUrl === "") return null;
    return {
      fetchAudio: ({ projectId: targetProject, turnId, language, voice, signal }) =>
        requestTtsAudio({
          siteUrl: resolvedSiteUrl,
          projectId: targetProject,
          turnId,
          language,
          voice,
          signal,
          token: tokenRef.current,
        }),
      createPlayback: createBrowserPlayback,
    };
  }, [environment, resolvedSiteUrl]);

  let content;
  if (data.status === "loading") {
    content = (
      <p role="status" className="state-block">
        Loading the latest tutor response…
      </p>
    );
  } else if (data.status === "error") {
    content = (
      <>
        <p role="alert">The tutor response could not be loaded.</p>
        <p>
          <button type="button" className="button" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        </p>
      </>
    );
  } else {
    content = (
      <>
        {turn !== null && turn.status === "running" && (
          <p role="status" className="turn-running">
            The tutor is still writing a response.{" "}
            <button type="button" className="button" onClick={() => void handleCancelTurn()} disabled={cancelBusy}>
              Cancel turn
            </button>
          </p>
        )}
        {data.response === null ? (
          <p role="status">No tutor response yet. Responses appear here with speech playback.</p>
        ) : defaultEnvironment === null ? (
          <p role="alert">Speech playback is not configured for this build.</p>
        ) : (
          <ResponsePlayerHost
            key={data.response.turnId}
            projectId={projectId}
            response={data.response}
            options={data.options}
            environment={defaultEnvironment}
            onRegisterCancel={registerCancel}
            cancelBusy={cancelBusy}
          />
        )}
      </>
    );
  }

  return (
    <section aria-label="Tutor response" className="tutor-response">
      <h3>Tutor response</h3>
      {content}
    </section>
  );
}
