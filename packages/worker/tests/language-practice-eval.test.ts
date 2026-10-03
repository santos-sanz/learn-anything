import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import {
  buildLanguagePracticeSystemPrompt,
  type CorrectionStyle,
  type LanguagePracticeConfig,
  type PracticeLevel,
} from "../src/index.js";

/**
 * S19 offline correction-style evaluation.
 *
 * The fixtures are reviewed synthetic beginner and intermediate dialogues.
 * No provider is called: a deterministic stand-in tutor plays the role of the
 * chat model by reading ONLY the system instruction - it refuses to run when
 * the prompt carries no correction-style or level directive, picks its reply
 * complexity from the level directive, and places corrections according to
 * the correction-style directive. Because the stand-in derives everything
 * from the prompt, the evaluation fails if two level/style configurations
 * ever produce the same prompt or the same behaviour.
 */

interface FixtureTurn {
  readonly learner: string;
  readonly correction: string;
  readonly shortExample: string;
  readonly beginnerReply: string;
  readonly intermediateReply: string;
  readonly advancedReply: string;
}

interface DialogueFixture {
  readonly id: string;
  readonly level: PracticeLevel;
  readonly targetLanguage: "en" | "es";
  readonly topic: string;
  readonly reviewed: boolean;
  readonly turns: readonly FixtureTurn[];
}

const fixtureFile = JSON.parse(readFileSync(new URL("./fixtures/language-practice-dialogues.json", import.meta.url), "utf8")) as {
  dialogues: DialogueFixture[];
};
const dialogues: readonly DialogueFixture[] = fixtureFile.dialogues;

const IMMEDIATE_DIRECTIVE = "Correct each mistake as soon as it appears, before you continue";
const END_OF_TURN_DIRECTIVE = "Do not interrupt the learner mid-turn";
const LEVEL_TOKENS: Record<PracticeLevel, string> = {
  beginner: "Keep sentences short",
  intermediate: "everyday conversational complexity",
  advanced: "natural pace, nuanced register",
};

const promptFor = (level: PracticeLevel, correctionStyle: CorrectionStyle, targetLanguage: "en" | "es"): string => {
  const languagePractice: LanguagePracticeConfig = {
    targetLanguage,
    level,
    correctionStyle,
    goals: ["Practise everyday conversation"],
    roleplayScenarios: [],
  };
  return buildLanguagePracticeSystemPrompt({ goal: "Practise every day", evidenceMode: "no-evidence", languagePractice });
};

/** Stand-in tutor: behaviour is a pure function of the system instruction. */
function scriptedTutor(system: string, turns: readonly FixtureTurn[]): string {
  const style: CorrectionStyle | null = system.includes(IMMEDIATE_DIRECTIVE)
    ? "immediate"
    : system.includes(END_OF_TURN_DIRECTIVE)
      ? "end-of-turn"
      : null;
  if (style === null) throw new Error("the system instruction carries no correction-style directive");
  const level: PracticeLevel | null = (Object.keys(LEVEL_TOKENS) as PracticeLevel[]).find((key) => system.includes(LEVEL_TOKENS[key])) ?? null;
  if (level === null) throw new Error("the system instruction carries no level directive");

  const replyFor = (turn: FixtureTurn): string =>
    level === "beginner" ? turn.beginnerReply : level === "advanced" ? turn.advancedReply : turn.intermediateReply;
  const lines: string[] = [];
  if (style === "immediate") {
    for (const turn of turns) {
      lines.push(`learner: ${turn.learner}`);
      lines.push(`tutor: ${replyFor(turn)}`);
      lines.push(`correction: ${turn.correction} | example: ${turn.shortExample}`);
    }
  } else {
    for (const turn of turns) {
      lines.push(`learner: ${turn.learner}`);
      lines.push(`tutor: ${replyFor(turn)}`);
    }
    lines.push("corrections:");
    for (const turn of turns) lines.push(`correction: ${turn.correction} | example: ${turn.shortExample}`);
  }
  return lines.join("\n");
}

const correctionLines = (transcript: string): string[] => transcript.split("\n").filter((line) => line.startsWith("correction:"));
const learnerIndexes = (transcript: string): number[] =>
  transcript.split("\n").map((line, index) => (line.startsWith("learner:") ? index : -1)).filter((index) => index >= 0);

test("the fixtures are reviewed synthetic beginner and intermediate dialogues", () => {
  expect(dialogues.length).toBeGreaterThanOrEqual(2);
  expect(dialogues.every((dialogue) => dialogue.reviewed)).toBe(true);
  expect(new Set(dialogues.map((dialogue) => dialogue.id)).size).toBe(dialogues.length);
  expect(dialogues.filter((dialogue) => dialogue.level === "beginner").length).toBeGreaterThanOrEqual(1);
  expect(dialogues.filter((dialogue) => dialogue.level === "intermediate").length).toBeGreaterThanOrEqual(1);
  for (const dialogue of dialogues) {
    expect(dialogue.turns.length).toBeGreaterThanOrEqual(2);
    for (const turn of dialogue.turns) {
      expect(turn.shortExample.length).toBeLessThanOrEqual(120);
      expect(turn.learner.length).toBeGreaterThan(10);
    }
  }
  // The data model carries practice history only - no scoring fields exist.
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      walk(child);
    }
  };
  walk(fixtureFile);
  for (const key of keys) expect(key).not.toMatch(/score|pronunciation|phoneme|proficien|certif|grade/i);
});

test("immediate and end-of-turn correction styles produce different behaviour on every dialogue", () => {
  for (const dialogue of dialogues) {
    const immediate = scriptedTutor(promptFor(dialogue.level, "immediate", dialogue.targetLanguage), dialogue.turns);
    const endOfTurn = scriptedTutor(promptFor(dialogue.level, "end-of-turn", dialogue.targetLanguage), dialogue.turns);

    expect(immediate).not.toBe(endOfTurn);

    // Immediate: every correction lands right after its own turn - before the
    // next learner line - so feedback arrives while the exchange is live.
    const immediateLines = immediate.split("\n");
    const learners = learnerIndexes(immediate);
    expect(learners).toHaveLength(dialogue.turns.length);
    dialogue.turns.forEach((turn, index) => {
      const correctionIndex = immediateLines.findIndex((line) => line.startsWith("correction:") && line.includes(turn.correction));
      expect(correctionIndex).toBeGreaterThan(learners[index]);
      if (index + 1 < learners.length) expect(correctionIndex).toBeLessThan(learners[index + 1]);
      else expect(correctionIndex).toBeGreaterThan(learners[learners.length - 1]);
    });

    // End-of-turn: no correction appears before the last learner line.
    const endLearners = learnerIndexes(endOfTurn);
    const endCorrections = correctionLines(endOfTurn);
    expect(endCorrections).toHaveLength(dialogue.turns.length);
    for (const lineIndex of endOfTurn.split("\n").map((line, i) => (line.startsWith("correction:") ? i : -1)).filter((i) => i >= 0)) {
      expect(lineIndex).toBeGreaterThan(endLearners[endLearners.length - 1]);
    }

    // Both styles keep corrections short and example-based.
    for (const line of [...correctionLines(immediate), ...endCorrections]) {
      expect(line.length).toBeLessThanOrEqual(200);
      expect(line).toContain("| example: ");
      expect(line).toContain(dialogue.turns.find((turn) => line.includes(turn.correction))?.shortExample ?? "");
    }
  }
});

test("the selected level changes the tutor's behaviour on the same dialogue", () => {
  for (const dialogue of dialogues) {
    const beginner = scriptedTutor(promptFor("beginner", "immediate", dialogue.targetLanguage), dialogue.turns);
    const intermediate = scriptedTutor(promptFor("intermediate", "immediate", dialogue.targetLanguage), dialogue.turns);
    expect(beginner).not.toBe(intermediate);
    for (const turn of dialogue.turns) {
      expect(beginner).toContain(turn.beginnerReply);
      expect(beginner).not.toContain(turn.intermediateReply);
      expect(intermediate).toContain(turn.intermediateReply);
      expect(intermediate).not.toContain(turn.beginnerReply);
    }
    const advanced = scriptedTutor(promptFor("advanced", "immediate", dialogue.targetLanguage), dialogue.turns);
    expect(advanced).not.toBe(beginner);
    expect(advanced).not.toBe(intermediate);
    for (const turn of dialogue.turns) {
      expect(advanced).toContain(turn.advancedReply);
      expect(advanced).not.toContain(turn.beginnerReply);
      expect(advanced).not.toContain(turn.intermediateReply);
    }
  }
});

test("all level, style and language combinations are distinct prompts and transcripts", () => {
  const dialogue = dialogues[0];
  const prompts = new Set<string>();
  const transcripts = new Set<string>();
  for (const level of ["beginner", "intermediate", "advanced"] as const) {
    for (const style of ["immediate", "end-of-turn"] as const) {
      for (const targetLanguage of ["es", "en"] as const) {
        const prompt = promptFor(level, style, targetLanguage);
        prompts.add(prompt);
        transcripts.add(scriptedTutor(prompt, dialogue.turns));
      }
    }
  }
  expect(prompts.size).toBe(12);
  // Six transcripts: level picks the reply style and style picks placement.
  // (Target language changes the prompt - and therefore the real model's
  // output language - but the stand-in speaks fixture English either way.)
  expect(transcripts.size).toBe(6);
});

test("neither prompts nor scripted transcripts claim proficiency or score pronunciation", () => {
  for (const dialogue of dialogues) {
    for (const style of ["immediate", "end-of-turn"] as const) {
      const prompt = promptFor(dialogue.level, style, dialogue.targetLanguage);
      const transcript = scriptedTutor(prompt, dialogue.turns);
      for (const line of prompt.split("\n")) {
        if (/proficien|certificate|pronunciation|phoneme|accent/i.test(line)) {
          expect(line.startsWith("- Never"), `non-prohibition claim line: ${line}`).toBe(true);
        }
      }
      expect(transcript.toLowerCase()).not.toMatch(/certified|proficiency|pronunciation|phoneme|c1 certificate/);
    }
  }
});
