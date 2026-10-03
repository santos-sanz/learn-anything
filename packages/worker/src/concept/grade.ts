import type { ActivityOutcome, ConceptActivity, GradedOutcome } from "./prompt.js";

/**
 * S20 activity grading and the question-first guard.
 *
 * - The verdict is read from the stored feedback text with one canonical
 *   `Verdict: ...` line per line; a missing or malformed line never becomes a
 *   grade — the turn resolves to `uncertain` instead of an invented result.
 * - `questionFirstSatisfied` is the server-side guard for asking activities:
 *   a `socratic` reply must ask a question, and an ungraded `teach-back`/
 *   `quiz` reply must ask a question (a checked reply carries its verdict
 *   instead). A lecture-only reply fails the turn visibly rather than being
 *   stored as if the tutor had engaged the learner.
 * - Outcomes describe one answer only. Nothing here scores a learner or
 *   claims a learning outcome.
 */

const VERDICT_LINE = /^verdict\s*:\s*(correct|partially[-\s]correct|wrong|uncertain)\.?\s*$/i;

/** The last canonical verdict line in the answer, or `null` when there is none. */
export function extractActivityVerdict(answer: string): GradedOutcome | null {
  let verdict: GradedOutcome | null = null;
  for (const line of answer.split(/\r?\n/)) {
    const match = VERDICT_LINE.exec(line.trim());
    if (match === null) continue;
    verdict = match[1].toLowerCase().replace(/\s+/g, "-") as GradedOutcome;
  }
  return verdict;
}

/** Whether the reply engages the learner with at least one question. */
export function hasQuestion(answer: string): boolean {
  return /[?？]/.test(answer);
}

/**
 * A reply must open/continue the dialogue unless the activity does not ask
 * (explain) or the reply already carries a checked verdict.
 */
export function requiresQuestionFirst(activity: ConceptActivity, answer: string): boolean {
  if (activity === "explain") return false;
  if (activity === "socratic") return true;
  return extractActivityVerdict(answer) === null;
}

export function questionFirstSatisfied(activity: ConceptActivity, answer: string): boolean {
  return !requiresQuestionFirst(activity, answer) || hasQuestion(answer);
}

/**
 * The recorded outcome for one activity turn: `completed` for turns that ask
 * or explain without grading, the verdict for checked feedback, and
 * `uncertain` when a checked turn yields neither a verdict nor a question —
 * never a grade the reply does not state.
 */
export function resolveActivityOutcome(activity: ConceptActivity, answer: string): ActivityOutcome {
  if (activity === "explain" || activity === "socratic") return "completed";
  const verdict = extractActivityVerdict(answer);
  if (verdict !== null) return verdict;
  return hasQuestion(answer) ? "completed" : "uncertain";
}
