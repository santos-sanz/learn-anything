import {
  MAX_RECORDING_SECONDS,
  TURN_LANGUAGES,
  formatElapsed,
  type TurnLanguage,
} from "./audioCapture.js";
import {
  ABORTED_MESSAGE,
  IDLE_HINT,
  blockedMessage,
  failureMessage,
  type TurnState,
} from "./turnState.js";

export type TurnCapturePanelProps = {
  state: TurnState;
  language: TurnLanguage;
  onLanguageChange: (language: TurnLanguage) => void;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  onEditTranscript: (text: string) => void;
};

/**
 * Pure presentation for the S15 microphone turn. Every capture state renders
 * as visible, keyboard-operable copy with an actionable next step; the
 * transcript stays editable before the learner moves on.
 */
export function TurnCapturePanel({
  state,
  language,
  onLanguageChange,
  onStart,
  onStop,
  onCancel,
  onEditTranscript,
}: TurnCapturePanelProps) {
  const languageSelect = (
    <p>
      <label htmlFor="turn-language">Input language</label>
      <select id="turn-language" value={language} onChange={(event) => onLanguageChange(event.target.value as TurnLanguage)}>
        {TURN_LANGUAGES.map((value) => (
          <option key={value} value={value}>
            {value === "en" ? "English" : "Spanish"}
          </option>
        ))}
      </select>
      <span>Transcription only; this build never translates.</span>
    </p>
  );

  let content;
  switch (state.phase) {
    case "idle":
      content = (
        <>
          <p>
            <button type="button" onClick={onStart}>
              Record a turn
            </button>
          </p>
          <p>{IDLE_HINT}</p>
        </>
      );
      break;
    case "requesting-permission":
      content = (
        <>
          <p role="status">Requesting microphone permission…</p>
          <p>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </p>
        </>
      );
      break;
    case "recording":
      content = (
        <>
          <p role="status">
            Recording {formatElapsed(state.elapsedMs)} of {formatElapsed(state.limitMs)}
          </p>
          <p>
            <button type="button" onClick={onStop}>
              Stop and transcribe
            </button>
            <button type="button" onClick={onCancel}>
              Cancel turn
            </button>
          </p>
        </>
      );
      break;
    case "analysing":
      content = (
        <>
          <p role="status">Checking the recording…</p>
          <p>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </p>
        </>
      );
      break;
    case "transcribing":
      content = (
        <>
          <p role="status">Transcribing your turn…</p>
          <p>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </p>
        </>
      );
      break;
    case "transcript":
      content = (
        <>
          <p>
            <label htmlFor="turn-transcript">Transcription (editable)</label>
            <textarea
              id="turn-transcript"
              rows={4}
              value={state.text}
              onChange={(event) => onEditTranscript(event.target.value)}
            />
          </p>
          <p role="status">
            Detected language: {state.detectedLanguage === "en" ? "English" : "Spanish"}
            {state.durationMs === null ? "" : ` · provider duration ${state.durationMs.toFixed(1)} s`}
          </p>
          <p>
            <button type="button" onClick={onStart}>
              Record another turn
            </button>
          </p>
        </>
      );
      break;
    case "blocked":
      content = (
        <>
          <p role="alert">{blockedMessage(state.reason)}</p>
          <p>
            <button type="button" onClick={onStart}>
              Try again
            </button>
          </p>
        </>
      );
      break;
    case "silence":
      content = (
        <>
          <p role="alert">{failureMessage("silence", null)}</p>
          <p>
            <button type="button" onClick={onStart}>
              Record again
            </button>
          </p>
        </>
      );
      break;
    case "failed":
      content = (
        <>
          <p role="alert">{failureMessage(state.code, state.retryAfterMs)}</p>
          <p>
            <button type="button" onClick={onStart}>
              Try again
            </button>
          </p>
        </>
      );
      break;
    case "aborted":
      content = (
        <>
          <p role="status">{ABORTED_MESSAGE}</p>
          <p>
            <button type="button" onClick={onStart}>
              Record again
            </button>
          </p>
        </>
      );
      break;
  }

  return (
    <section aria-label="Microphone turn">
      <h3>Microphone turn</h3>
      {languageSelect}
      {content}
      <p>Turns are limited to {MAX_RECORDING_SECONDS} seconds and short audio only.</p>
    </section>
  );
}
