import { api } from "@learn-anything/api/convex/_generated/api";
import type { Id } from "@learn-anything/api/convex/_generated/dataModel";
import type { ConvexReactClient } from "convex/react";

/** The newest stored tutor response of a project, as the player renders it. */
export type TutorResponseSummary = { turnId: string; text: string; createdAt: number };

export type SpeechVoiceOption = { id: string; language: string; label: string };

/** The server's configured Kokoro contract; the browser never reads provider configuration itself. */
export type SpeechOptions = {
  model: string;
  format: "mp3";
  languages: string[];
  voices: SpeechVoiceOption[];
  maxTextChars: number;
};

export type TutorTurnStatus = "running" | "completed" | "cancelled" | "failed";
export type TutorTurnSummary = { turnId: string; status: TutorTurnStatus; createdAt: number };

export type TutorBackend = {
  latestResponse(projectId: string): Promise<TutorResponseSummary | null>;
  latestTurn(projectId: string): Promise<TutorTurnSummary | null>;
  speechOptions(): Promise<SpeechOptions>;
  /** S14 cancellation; a finished turn answers `already-completed` server-side. */
  cancelTurn(projectId: string, turnId: string): Promise<void>;
};

type ConvexClient = Pick<ConvexReactClient, "query" | "mutation">;

const asProjectId = (id: string) => id as Id<"projects">;

/**
 * The production data port for S16: reads go through the authorized Convex
 * functions (S05/S06 identity and ownership re-derived server-side) and the
 * voice catalog comes from `tts.speechOptions`, never from client-side
 * provider configuration.
 */
export function makeConvexTutorBackend(client: ConvexClient): TutorBackend {
  return {
    async latestResponse(projectId) {
      const transcript = await client.query(api.tutor.getTranscript, { projectId: asProjectId(projectId) });
      for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
        const message = transcript.messages[index];
        if (message.role === "tutor") return { turnId: message.turnId, text: message.content, createdAt: message.createdAt };
      }
      return null;
    },
    async latestTurn(projectId) {
      return await client.query(api.tutor.latestTurn, { projectId: asProjectId(projectId) });
    },
    async speechOptions() {
      return await client.query(api.tts.speechOptions, {});
    },
    async cancelTurn(projectId, turnId) {
      await client.mutation(api.tutor.cancelTurn, { projectId: asProjectId(projectId), turnId });
    },
  };
}
