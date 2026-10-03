import { expect, test } from "vitest";

import { NanClient, MAX_TRANSLATION_SOURCE_CHARS, buildTranslationSystemPrompt } from "../src/index.js";

const deployment = { mode: "single-user-self-hosted" as const, learnerId: "owner", deployerId: "owner" };
const audio = { bytes: new Uint8Array([1, 2, 3]), filename: "turn.webm", mimeType: "audio/webm" };

function clientWith(fetch: typeof globalThis.fetch): NanClient {
  return new NanClient({ apiKey: "synthetic-server-token", fetch, deployment, quotaControls: { timeoutMs: 100 } });
}

test("audio translation posts to Whisper's translation endpoint in English only", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = clientWith(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ text: "the library is closed" });
  });

  const result = await client.translateAudioToEnglish(audio);

  expect(result).toEqual({ text: "the library is closed", language: "en" });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.nan.builders/v1/audio/translations");
  expect(calls[0].url).not.toContain("/audio/transcriptions");
  const form = calls[0].init?.body as FormData;
  expect(form.get("model")).toBe("whisper");
  expect(form.has("language")).toBe(false);
});

test("an audio translation that is not English is a malformed response, never a relabelled one", async () => {
  const spanish = clientWith(async () => Response.json({ text: "biblioteca cerrada", language: "es" }));
  await expect(spanish.translateAudioToEnglish(audio)).rejects.toMatchObject({ code: "NAN_MALFORMED_RESPONSE" });

  const missingText = clientWith(async () => Response.json({ language: "en" }));
  await expect(missingText.translateAudioToEnglish(audio)).rejects.toMatchObject({ code: "NAN_MALFORMED_RESPONSE" });
});

test("audio translation obeys the same policy gate as every other NaN capability", async () => {
  const restricted = new NanClient({
    apiKey: "synthetic-server-token",
    deployment: { mode: "hosted-multiuser" as const, learnerId: "learner" },
    fetch: async () => Response.json({ text: "x" }),
  });
  await expect(restricted.translateAudioToEnglish(audio)).rejects.toMatchObject({ code: "NAN_POLICY_BLOCKED" });
});

test("text translation builds its instruction only from the validated language pair", () => {
  const prompt = buildTranslationSystemPrompt("es", "en");
  expect(prompt).toContain("Spanish");
  expect(prompt).toContain("English");
  expect(prompt).toContain("untrusted data");
  expect(prompt).toBe(buildTranslationSystemPrompt("es", "en")); // deterministic: no source text, no randomness
});

test("translating a language into itself returns the text without a provider request", async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { content: "unused" } }] });
  });
  await expect(client.translateText("hola", "es", "es")).resolves.toBe("hola");
  expect(calls).toBe(0);
});

test("oversized source text is rejected before any request is built", async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { content: "unused" } }] });
  });
  await expect(client.translateText("x".repeat(MAX_TRANSLATION_SOURCE_CHARS + 1), "en", "es"))
    .rejects.toMatchObject({ code: "NAN_INPUT_TOO_LARGE" });
  expect(calls).toBe(0);
});
