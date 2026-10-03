import {
  MAX_RECORDING_SECONDS,
  TURN_LANGUAGES,
  formatElapsed,
  type TurnLanguage,
} from "./audioCapture.js";
import {
  audioTranslationSupport,
  languageName,
  textTranslationBlockedReason,
  textTranslationFailureMessage,
  TURN_ACTION_OPTIONS,
  TRANSLATION_LANGUAGES,
  type TextTranslationState,
  type TranslationLanguage,
} from "./translationState.js";
import {
  ABORTED_MESSAGE,
  IDLE_HINT,
  blockedMessage,
  failureMessage,
  type TurnAction,
  type TurnState,
} from "./turnState.js";

export type TurnCapturePanelProps = {
  state: TurnState;
  action: TurnAction | null;
  onActionChange: (action: TurnAction) => void;
  language: TurnLanguage;
  onLanguageChange: (language: TurnLanguage) => void;
  target: TranslationLanguage;
  onTargetChange: (target: TranslationLanguage) => void;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  onEditTranscript: (text: string) => void;
  textTranslation: TextTranslationState;
  onEditSourceText: (text: string) => void;
  onSourceLanguageChange: (source: TranslationLanguage) => void;
  onTranslateText: () => void;
  onClearTranslation: () => void;
};

/**
 * Pure presentation for S15 capture plus the S18 translation choices. The three
 * actions are separate, labelled options with no default, the target language
 * is always the learner's explicit choice, and a translation is rendered next
 * to the original text instead of replacing it.
 */
export function TurnCapturePanel({
  state,
  action,
  onActionChange,
  language,
  onLanguageChange,
  target,
  onTargetChange,
  onStart,
  onStop,
  onCancel,
  onEditTranscript,
  textTranslation,
  onEditSourceText,
  onSourceLanguageChange,
  onTranslateText,
  onClearTranslation,
}: TurnCapturePanelProps) {
  const actionPicker = (
    <fieldset>
      <legend>What should this turn do?</legend>
      {TURN_ACTION_OPTIONS.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name="turn-action"
            value={option.value}
            checked={action === option.value}
            onChange={() => onActionChange(option.value)}
          />
          <span>
            <strong>{option.label}</strong> — {option.help}
          </span>
        </label>
      ))}
    </fieldset>
  );

  const languageSelect =
    action === "transcribe" ? (
      <p>
        <label htmlFor="turn-language">Input language</label>
        <select id="turn-language" value={language} onChange={(event) => onLanguageChange(event.target.value as TurnLanguage)}>
          {TURN_LANGUAGES.map((value) => (
            <option key={value} value={value}>
              {value === "en" ? "English" : "Spanish"}
            </option>
          ))}
        </select>
        <span>Transcription keeps this language and never translates.</span>
      </p>
    ) : null;

  const audioSupport = audioTranslationSupport(target);
  const targetSelect = (labelId: string) => (
    <p>
      <label htmlFor={labelId}>Target language</label>
      <select id={labelId} value={target} onChange={(event) => onTargetChange(event.target.value as TranslationLanguage)}>
        {TRANSLATION_LANGUAGES.map((value) => (
          <option key={value} value={value}>
            {languageName(value)}
          </option>
        ))}
      </select>
    </p>
  );

  const recordLabel =
    action === "translate-audio" ? "Record audio to translate to English" : "Record speech to fill the text";
  /** Whisper cannot target another language, so recording is refused up front. */
  const audioActionBlocked = action === "translate-audio" && !audioSupport.supported;

  let content;
  switch (state.phase) {
    case "idle":
      content =
        action === null ? (
          <p>Choose what this turn should do above, then record.</p>
        ) : audioActionBlocked ? (
          <p>Audio translation to this target is not supported, so this turn cannot be recorded for it.</p>
        ) : (
          <>
            <p>
              <button type="button" onClick={onStart}>
                {action === "transcribe" ? "Record a turn" : recordLabel}
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
              {action === "translate-audio" ? "Stop and translate to English" : "Stop and transcribe"}
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
          <p role="status">{action === "translate-audio" ? "Translating your audio to English…" : "Transcribing your turn…"}</p>
          <p>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </p>
        </>
      );
      break;
    case "transcript":
      content =
        action === "translate-text" ? (
          <>
            <p role="status">Your recording was transcribed into the text below.</p>
            <p>
              <button type="button" onClick={onStart}>
                Record another turn
              </button>
            </p>
          </>
        ) : state.kind === "audio-translation" ? (
          <>
            <p>
              <label htmlFor="turn-transcript">Audio translation to English (editable)</label>
              <textarea
                id="turn-transcript"
                rows={4}
                value={state.text}
                onChange={(event) => onEditTranscript(event.target.value)}
              />
            </p>
            <p role="status">
              Whisper's audio translation outputs English only; the recording was discarded after translation.
              {state.durationMs === null ? "" : ` provider duration ${state.durationMs.toFixed(1)} s`}
            </p>
            <p>
              <button type="button" onClick={onStart}>
                Record another turn
              </button>
            </p>
          </>
        ) : (
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

  const microphoneSection = (
    <section aria-label="Microphone turn">
      <h3>Microphone turn</h3>
      {actionPicker}
      {action === null ? null : languageSelect}
      {action === "translate-audio" ? (
        <>
          {targetSelect("audio-target-language")}
          <p role="note">Whisper's audio translation only produces English; other targets are refused, never silently replaced.</p>
        </>
      ) : null}
      {audioActionBlocked && audioSupport.message !== null ? (
        <p role="alert">
          {audioSupport.message}{" "}
          <button type="button" onClick={() => onActionChange("translate-text")}>
            Translate the text instead
          </button>
        </p>
      ) : null}
      {content}
      <p>Turns are limited to {MAX_RECORDING_SECONDS} seconds and short audio only.</p>
    </section>
  );

  const showTextTranslation = action === "translate-text" || textTranslation.phase !== "idle";
  const blockedReason = textTranslationBlockedReason(textTranslation, target);
  const sourceLabelId = "text-source-language";
  const resultTarget = textTranslation.result?.target ?? target;

  const textTranslationSection = showTextTranslation ? (
    <section aria-label="Text translation">
      <h3>Text translation</h3>
      <p>
        Translates text you already have. The original stays here next to the translation, so nothing is replaced
        without a way back.
      </p>
      <p>
        <label htmlFor={sourceLabelId}>Source language</label>
        <select
          id={sourceLabelId}
          value={textTranslation.source}
          onChange={(event) => onSourceLanguageChange(event.target.value as TranslationLanguage)}
        >
          {TRANSLATION_LANGUAGES.map((value) => (
            <option key={value} value={value}>
              {languageName(value)}
            </option>
          ))}
        </select>
        <span> translates into the target language chosen below.</span>
      </p>
      {targetSelect("text-target-language")}
      <div>
        <p>
          <label htmlFor="text-source">Original text ({languageName(textTranslation.source)})</label>
          <textarea
            id="text-source"
            rows={4}
            value={textTranslation.original}
            onChange={(event) => onEditSourceText(event.target.value)}
          />
        </p>
        <div role="group" aria-label={`Translation (${languageName(resultTarget)})`}>
          <h4>Translation ({languageName(resultTarget)})</h4>
          {textTranslation.phase === "done" && textTranslation.result !== null ? (
            <p>{textTranslation.result.translation}</p>
          ) : textTranslation.phase === "pending" ? (
            <p role="status">Translating…</p>
          ) : (
            <p>The translation appears here, next to your original text.</p>
          )}
        </div>
      </div>
      <p>
        <button type="button" onClick={onTranslateText} disabled={blockedReason !== null}>
          Translate text
        </button>
        {blockedReason !== null ? <span> {blockedReason}</span> : null}
        {textTranslation.phase === "done" ? (
          <button type="button" onClick={onClearTranslation}>
            Clear translation
          </button>
        ) : null}
      </p>
      {textTranslation.phase === "failed" && textTranslation.code !== null ? (
        <p role="alert">{textTranslationFailureMessage(textTranslation.code, textTranslation.retryAfterMs)}</p>
      ) : null}
      {textTranslation.result?.unchanged === true ? (
        <p role="status">Source and target are the same language, so the text was returned unchanged.</p>
      ) : null}
    </section>
  ) : null;

  return (
    <>
      {microphoneSection}
      {textTranslationSection}
    </>
  );
}
