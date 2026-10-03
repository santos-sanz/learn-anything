import {
  conversationActions,
  conversationMessage,
  conversationStageStates,
  type ConversationState,
} from "./conversationState.js";

/** Fixed labels: the stage names are part of the S17 contract, not free copy. */
const STAGE_LABELS: Record<string, string> = {
  listening: "Listening",
  transcribing: "Transcribing",
  generating: "Retrieving & generating",
  speaking: "Speaking",
  ready: "Ready",
};

const STEP_STATE_LABELS = {
  done: "done",
  current: "in progress",
  error: "failed",
  waiting: "waiting",
} as const;

/** `ready` is the resting step: "in progress" would read as work running. */
function stepLabel(stage: string, step: keyof typeof STEP_STATE_LABELS): string {
  if (step === "current" && stage === "ready") return "reached";
  return STEP_STATE_LABELS[step];
}

export type ConversationStageTrackProps = {
  state: ConversationState;
  onAction: (action: string) => void;
};

/**
 * S17 stage visibility: all five pipeline steps render at all times with a
 * visible per-step state (`done` / `in progress` / `failed` / `waiting`), plus
 * one live status line (`role="status"` or `role="alert"`) and the Retry /
 * Cancel controls the current stage offers. Nothing here is decorative — the
 * acceptance criteria require every stage and every error to be visible.
 */
export function ConversationStageTrack({ state, onAction }: ConversationStageTrackProps) {
  const message = conversationMessage(state);
  const actions = conversationActions(state);
  const steps = conversationStageStates(state);

  return (
    <div className="stage-track">
      <ol className="stage-list" aria-label="Conversation stages">
        {steps.map((step) => (
          <li
            key={step.stage}
            className="stage-item"
            data-stage={step.stage}
            data-state={step.state}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <span className="stage-name">{STAGE_LABELS[step.stage]}</span>
            <span className="stage-result">{stepLabel(step.stage, step.state)}</span>
          </li>
        ))}
      </ol>
      <p role={message.role} className="stage-status">
        {message.text}
      </p>
      {actions.length > 0 && (
        <p className="stage-actions">
          {actions.map((action) => (
            <button
              key={action.kind}
              type="button"
              className={action.kind === "retry" ? "button button-primary" : "button"}
              onClick={() => onAction(action.kind)}
            >
              {action.label}
            </button>
          ))}
        </p>
      )}
    </div>
  );
}
