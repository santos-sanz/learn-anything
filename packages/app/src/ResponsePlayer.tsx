import { playerMessage, type PlayerState } from "./playerState.js";

export type PlayerLanguageOption = { code: string; label: string };

export type ResponsePlayerProps = {
  /** The complete tutor response: rendered in every phase, never replaced by the player state. */
  transcript: string;
  state: PlayerState;
  language: string;
  languages: readonly PlayerLanguageOption[];
  onLanguageChange: (language: string) => void;
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRetry: () => void;
  /** Set while the S14 turn itself is being cancelled. */
  cancelBusy?: boolean;
};

/**
 * Pure presentation for S16 playback of one tutor response. The transcript
 * sits above the controls and is rendered unconditionally — a failed fetch, a
 * blocked autoplay or a cancellation changes only the status line and the
 * available buttons, so the text is never blanked and Retry is always offered
 * after a failure.
 */
export function ResponsePlayer({
  transcript,
  state,
  language,
  languages,
  onLanguageChange,
  onPlay,
  onPause,
  onResume,
  onStop,
  onRetry,
  cancelBusy = false,
}: ResponsePlayerProps) {
  const message = playerMessage(state);
  const showPlay = state.phase === "idle" || state.phase === "autoplay-blocked" || state.phase === "ended" || state.phase === "cancelled";
  const showStop = state.phase === "loading" || state.phase === "playing" || state.phase === "paused" || state.phase === "autoplay-blocked";

  return (
    <div className="response-player">
      <p className="player-transcript">{transcript}</p>
      <p role={message.role} className="player-status">
        {message.text}
      </p>
      <p className="player-controls">
        {showPlay && (
          <button type="button" className="button button-primary" onClick={onPlay}>
            Play audio
          </button>
        )}
        {state.phase === "playing" && (
          <button type="button" className="button" onClick={onPause}>
            Pause
          </button>
        )}
        {state.phase === "paused" && (
          <button type="button" className="button" onClick={onResume}>
            Resume
          </button>
        )}
        {state.phase === "failed" && (
          <button type="button" className="button button-primary" onClick={onRetry}>
            Retry
          </button>
        )}
        {showStop && (
          <button type="button" className="button" onClick={onStop} disabled={cancelBusy}>
            Stop
          </button>
        )}
      </p>
      {languages.length > 0 && (
        <p>
          <label htmlFor="player-language">Speech language</label>
          <select id="player-language" value={language} onChange={(event) => onLanguageChange(event.target.value)}>
            {languages.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </p>
      )}
    </div>
  );
}
