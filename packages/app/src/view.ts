import { ConvexError } from "convex/values";

import type { LearningMode, ProjectPatch, ProjectSummary } from "./data/projects.js";

export type ProjectFormValues = { name: string; goal: string; mode: LearningMode | null };

export type ProjectFormErrors = { name?: string; goal?: string; mode?: string };

const NAME_MAX = 100;
const GOAL_MAX = 500;

/** Pure client-side validation; the server revalidates every field (S05). */
export function validateProjectForm(values: ProjectFormValues, options: { requireMode: boolean }): ProjectFormErrors {
  const errors: ProjectFormErrors = {};
  const name = values.name.trim();
  if (name === "") errors.name = "Enter a project name.";
  else if (name.length > NAME_MAX) errors.name = `Use ${NAME_MAX} characters or fewer.`;
  const goal = values.goal.trim();
  if (goal.length > GOAL_MAX) errors.goal = `Use ${GOAL_MAX} characters or fewer.`;
  if (options.requireMode && values.mode === null) errors.mode = "Choose a learning mode.";
  return errors;
}

export function hasFormErrors(errors: ProjectFormErrors): boolean {
  return errors.name !== undefined || errors.goal !== undefined || errors.mode !== undefined;
}

/** Create payload: an empty goal is simply unset. */
export function toDraft(values: ProjectFormValues): { name: string; goal?: string; mode?: LearningMode } {
  const draft: { name: string; goal?: string; mode?: LearningMode } = { name: values.name.trim() };
  const goal = values.goal.trim();
  if (goal !== "") draft.goal = goal;
  if (values.mode !== null) draft.mode = values.mode;
  return draft;
}

/** Edit payload: `goal` is always sent, where "" clears the stored selection. */
export function toPatch(values: ProjectFormValues): ProjectPatch {
  const patch: ProjectPatch = { name: values.name.trim(), goal: values.goal.trim() };
  if (values.mode !== null) patch.mode = values.mode;
  return patch;
}

export function toFormValues(project: ProjectSummary): ProjectFormValues {
  return { name: project.name, goal: project.goal ?? "", mode: project.mode ?? null };
}

/** Typed Convex error codes travel in `error.data`; message fallback covers older shapes. */
export function dataErrorCode(error: unknown): string | null {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "object" && data !== null && "code" in data && typeof (data as { code: unknown }).code === "string") {
      return (data as { code: string }).code;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  for (const code of ["UNAUTHENTICATED", "NOT_FOUND", "INVALID_ARGUMENT"]) {
    if (message.includes(code)) return code;
  }
  return null;
}

/** Fixed, safe copy: raw backend messages can leak internals and help nobody. */
export function mapDataError(error: unknown, context: "list" | "form" | "project" = "form"): string {
  const code = dataErrorCode(error);
  if (code === "UNAUTHENTICATED") return "Your session has ended. Sign in again to continue.";
  if (code === "NOT_FOUND") return context === "project" ? "This project doesn’t exist or isn’t yours." : "That project is no longer available.";
  if (code === "INVALID_ARGUMENT") return "Check the highlighted fields and try again.";
  if (context === "list") return "Couldn’t load your projects.";
  if (context === "project") return "Couldn’t load this project.";
  return "That didn’t go through. Check your connection and try again.";
}

export const MODE_LABELS: Record<LearningMode, string> = {
  "language-practice": "Language practice",
  "concept-learning": "Concept learning",
};

export function modeLabel(mode: LearningMode | undefined): string | null {
  return mode === undefined ? null : MODE_LABELS[mode];
}
