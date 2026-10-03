import { api } from "@learn-anything/api/convex/_generated/api";
import type { Id } from "@learn-anything/api/convex/_generated/dataModel";
import type { ConvexReactClient } from "convex/react";

import type { ConversationHistoryMessage } from "../conversationState.js";
import { makeConvexTutorBackend, type TutorBackend, type TutorTurnStatus } from "./tutor.js";

/**
 * S17 conversation port: the S14 turn surface the state machine drives, on
 * top of the S16 `TutorBackend`. Production reads/writes go through the same
 * authorized Convex functions as everything else (identity and ownership are
 * re-derived server-side); tests inject fakes or the in-process convex-test
 * instance, so no live provider is ever reached from the browser bundle.
 */

export type RunTurnInput = { projectId: string; turnId: string; text: string };
export type RunTurnSuccess = { ok: true; turnId: string; text: string; replayed: boolean };
/**
 * `ambiguous` marks a failure where the server may still have started (or
 * finished) the turn — a dropped connection, or a live/failed-over attempt.
 * The machine retries those with the *same* turn id so S14 idempotency
 * replays instead of double-sending; typed terminal failures retry with a
 * fresh id because that turn wrote no messages.
 */
export type RunTurnFailure = { ok: false; code: string; retryAfterMs: number | null; ambiguous: boolean };
export type RunTurnResult = RunTurnSuccess | RunTurnFailure;

export type ConversationTurn = { turnId: string; status: TutorTurnStatus; failureCode: string | null };

export type ConversationTranscriptPage = {
  messages: ConversationHistoryMessage[];
  droppedCitations: number;
};

export type ConversationBackend = TutorBackend & {
  /** S14 `runTurn`: one idempotent attempt; never a second message set. */
  runTurn(input: RunTurnInput): Promise<RunTurnResult>;
  /** Owner-only status of one turn; used to restore a failed turn's code. */
  getTurn(projectId: string, turnId: string): Promise<ConversationTurn | null>;
  /** Stored transcripts with re-validated citations (the reconnect source of truth). */
  transcript(projectId: string): Promise<ConversationTranscriptPage>;
};

type ConvexClient = Pick<ConvexReactClient, "query" | "mutation" | "action">;

const asProjectId = (id: string) => id as Id<"projects">;

function stringField(value: unknown, key: string): string | null {
  if (typeof value === "object" && value !== null) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "string") return field;
  }
  return null;
}

/**
 * Recovers a typed failure from whatever `runTurn` rejected with. A Convex
 * error carries `{ code, retryAfterMs }` in `.data`; anything else (a dropped
 * connection, a proxy timeout) is deliberately classified as ambiguous, which
 * is the safe direction: the retry reuses the turn id and S14 replays.
 */
export function runTurnFailure(error: unknown): RunTurnFailure {
  const data: unknown = (error as { data?: unknown } | null)?.data;
  const dataCode = stringField(data, "code");
  const retryAfterMs =
    typeof data === "object" && data !== null && typeof (data as { retryAfterMs?: unknown }).retryAfterMs === "number"
      ? (data as { retryAfterMs: number }).retryAfterMs
      : null;
  if (dataCode !== null) {
    const ambiguous = dataCode === "TURN_IN_PROGRESS" || dataCode === "TURN_ATTEMPT_LOST";
    return { ok: false, code: dataCode, retryAfterMs, ambiguous };
  }
  const message = error instanceof Error ? error.message : String(error);
  const jsonCode = /\{"code"\s*:\s*"([A-Z0-9_]+)"/.exec(message);
  if (jsonCode !== null) {
    const ambiguous = jsonCode[1] === "TURN_IN_PROGRESS" || jsonCode[1] === "TURN_ATTEMPT_LOST";
    return { ok: false, code: jsonCode[1], retryAfterMs, ambiguous };
  }
  const token = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/.exec(message);
  if (token !== null) {
    const ambiguous = token[1] === "TURN_IN_PROGRESS" || token[1] === "TURN_ATTEMPT_LOST";
    return { ok: false, code: token[1], retryAfterMs: null, ambiguous };
  }
  // No typed answer ever arrived: assume the turn may be running and let the
  // idempotent retry pick up (or replay) its result.
  return { ok: false, code: "network", retryAfterMs: null, ambiguous: true };
}

/**
 * The production port. `makeConvexTutorBackend` (S16) provides the transcript
 * / turn / speech / cancel reads; this adds the S14 action and the paged
 * transcript read with citations.
 */
export function makeConvexConversationBackend(client: ConvexClient): ConversationBackend {
  return {
    ...makeConvexTutorBackend(client),
    async runTurn({ projectId, turnId, text }) {
      try {
        const result = await client.action(api.tutor.runTurn, { projectId: asProjectId(projectId), turnId, text });
        return { ok: true, turnId: result.turnId, text: result.text, replayed: result.replayed };
      } catch (error) {
        return runTurnFailure(error);
      }
    },
    async getTurn(projectId, turnId) {
      const turn = await client.query(api.tutor.getTurn, { projectId: asProjectId(projectId), turnId });
      if (turn === null) return null;
      return { turnId: turn.turnId, status: turn.status, failureCode: turn.failureCode };
    },
    async transcript(projectId) {
      const page = await client.query(api.tutor.getTranscript, { projectId: asProjectId(projectId) });
      return {
        messages: page.messages.map((message) => ({
          turnId: message.turnId,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          citations: message.citations.map((citation) => ({
            rank: citation.rank,
            documentId: citation.documentId as string,
            chunkId: citation.chunkId as string,
            seq: citation.seq,
            contentHash: citation.contentHash,
            page: citation.page,
            heading: citation.heading,
          })),
        })),
        droppedCitations: page.droppedCitations,
      };
    },
  };
}
