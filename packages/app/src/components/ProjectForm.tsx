import { useState, type FormEvent } from "react";

import { LEARNING_MODES, type LearningMode } from "../data/projects.js";
import { hasFormErrors, MODE_LABELS, validateProjectForm, type ProjectFormErrors, type ProjectFormValues } from "../view.js";

export type ProjectFormProps = {
  initialValues?: ProjectFormValues;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  requireMode: boolean;
  onSubmit: (values: ProjectFormValues) => void | Promise<void>;
  onCancel?: () => void;
};

const EMPTY_VALUES: ProjectFormValues = { name: "", goal: "", mode: null };

const MODE_HINTS: Record<LearningMode, string> = {
  "language-practice": "Practise speaking and understanding a language with a tutor.",
  "concept-learning": "Understand new concepts step by step, with explanations and questions.",
};

const NAME_MAX = 100;
const GOAL_MAX = 500;

/**
 * Shared create/edit form. Every control is a labelled native element so
 * keyboard and screen-reader operation comes for free; validation errors are
 * announced with `role="alert"` and move focus to the first invalid field.
 */
export function ProjectForm({ initialValues = EMPTY_VALUES, submitLabel, busy, error, requireMode, onSubmit, onCancel }: ProjectFormProps) {
  const [values, setValues] = useState<ProjectFormValues>(initialValues);
  const [errors, setErrors] = useState<ProjectFormErrors>({});

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validateProjectForm(values, { requireMode });
    setErrors(found);
    if (hasFormErrors(found)) {
      const firstInvalid = found.name !== undefined ? "project-name" : found.goal !== undefined ? "project-goal" : `project-mode-${LEARNING_MODES[0]}`;
      document.getElementById(firstInvalid)?.focus();
      return;
    }
    void onSubmit(values);
  };

  return (
    <form className="project-form" onSubmit={handleSubmit} noValidate>
      <fieldset className="form-fields">
        <legend className="visually-hidden">Project details</legend>
        <p className="field">
          <label htmlFor="project-name">Project name</label>
          <input
            id="project-name"
            name="name"
            type="text"
            autoComplete="off"
            required
            disabled={busy}
            maxLength={NAME_MAX}
            value={values.name}
            aria-invalid={errors.name !== undefined}
            aria-describedby={errors.name === undefined ? undefined : "project-name-error"}
            onChange={(event) => setValues({ ...values, name: event.target.value })}
          />
          {errors.name !== undefined && (
            <span className="field-error" id="project-name-error" role="alert">
              {errors.name}
            </span>
          )}
        </p>

        <p className="field">
          <label htmlFor="project-goal">Learning goal</label>
          <span className="field-hint" id="project-goal-hint">
            What do you want to achieve? Leave it empty if you are not sure yet.
          </span>
          <textarea
            id="project-goal"
            name="goal"
            rows={3}
            disabled={busy}
            maxLength={GOAL_MAX}
            value={values.goal}
            aria-invalid={errors.goal !== undefined}
            aria-describedby={errors.goal === undefined ? "project-goal-hint" : "project-goal-error"}
            onChange={(event) => setValues({ ...values, goal: event.target.value })}
          />
          {errors.goal !== undefined && (
            <span className="field-error" id="project-goal-error" role="alert">
              {errors.goal}
            </span>
          )}
        </p>

        <fieldset className="mode-fieldset">
          <legend>Learning mode</legend>
          {LEARNING_MODES.map((mode) => (
            <div className="mode-option" key={mode}>
              <input
                id={`project-mode-${mode}`}
                type="radio"
                name="mode"
                value={mode}
                disabled={busy}
                required={requireMode}
                checked={values.mode === mode}
                aria-invalid={errors.mode !== undefined}
                aria-describedby={errors.mode === undefined ? `project-mode-${mode}-hint` : `project-mode-error project-mode-${mode}-hint`}
                onChange={() => setValues({ ...values, mode })}
              />
              <label className="mode-option-label" htmlFor={`project-mode-${mode}`}>
                {MODE_LABELS[mode]}
              </label>
              <span className="field-hint" id={`project-mode-${mode}-hint`}>
                {MODE_HINTS[mode]}
              </span>
            </div>
          ))}
          {errors.mode !== undefined && (
            <span className="field-error" id="project-mode-error" role="alert">
              {errors.mode}
            </span>
          )}
        </fieldset>
      </fieldset>

      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <p className="form-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel !== undefined && (
          <button type="button" className="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </p>
    </form>
  );
}
