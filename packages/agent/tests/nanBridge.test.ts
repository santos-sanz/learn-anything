import { NAN_BASE_URL, type NanFetch } from "@learn-anything/worker";
import { expect, test } from "vitest";

import { createNanBridge } from "../src/nanBridge.js";

const DEPLOYER = "user_owner_1";
const EMBEDDING_4096 = Array.from({ length: 4096 }, () => 0);

type RecordedCall = { url: string; authorization: string | null; body: unknown };

const recordingFetch = (calls: RecordedCall[]): NanFetch => async (url, init) => {
  calls.push({
    url,
    authorization: new Headers(init?.headers).get("authorization"),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
  });
  if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "synthetic tutor reply" } }] });
  if (url.endsWith("/audio/speech")) return new Response(new Uint8Array([1, 2, 3]));
  if (url.endsWith("/embeddings")) return Response.json({ data: [{ embedding: EMBEDDING_4096 }] });
  if (url.endsWith("/rerank")) return Response.json({ results: [{ index: 0, relevance_score: 0.9 }] });
  return Response.json({});
};

const env = { NAN_API_KEY: "test-not-a-real-nan-key", NAN_DEPLOYER_ID: DEPLOYER };

test("routes LLM, speech, embeddings and rerank through the S11 NaN adapter", async () => {
  const calls: RecordedCall[] = [];
  const bridge = createNanBridge(env, { learnerOwnerId: DEPLOYER }, recordingFetch(calls));

  const reply = await bridge.tutor("Explain photosynthesis.");
  expect(reply).toBe("synthetic tutor reply");

  const audio = await bridge.speech("hello");
  expect(audio.byteLength).toBe(3);

  const vectors = await bridge.embeddings(["chunk one"]);
  expect(vectors).toHaveLength(1);
  expect(vectors[0]).toHaveLength(4096);

  const ranked = await bridge.rerank("query", ["candidate"]);
  expect(ranked).toEqual([{ index: 0, relevanceScore: 0.9 }]);

  expect(calls).toHaveLength(4);
  for (const call of calls) {
    expect(call.url.startsWith(NAN_BASE_URL)).toBe(true);
    expect(call.authorization).toBe("Bearer test-not-a-real-nan-key");
  }
  const chat = calls[0];
  expect(chat.url).toBe(`${NAN_BASE_URL}/chat/completions`);
  expect((chat.body as { model: string }).model).toBe("deepseek-v4-flash");
  expect((chat.body as { messages: Array<{ role: string }> }).messages[0].role).toBe("system");
});

test("blocks every capability for a learner who is not the configured deployer", async () => {
  const calls: RecordedCall[] = [];
  const bridge = createNanBridge(env, { learnerOwnerId: "user_owner_2" }, recordingFetch(calls));

  await expect(bridge.tutor("hola")).rejects.toMatchObject({ code: "NAN_POLICY_BLOCKED" });
  await expect(bridge.speech("hola")).rejects.toMatchObject({ code: "NAN_POLICY_BLOCKED" });
  await expect(bridge.embeddings(["hola"])).rejects.toMatchObject({ code: "NAN_POLICY_BLOCKED" });
  await expect(bridge.rerank("q", ["d"])).rejects.toMatchObject({ code: "NAN_POLICY_BLOCKED" });
  expect(calls).toHaveLength(0);
});

test("refuses to construct a client without a server-side NaN key", () => {
  const createWithoutKey = (): unknown => {
    try {
      createNanBridge({ NAN_API_KEY: "", NAN_DEPLOYER_ID: DEPLOYER }, { learnerOwnerId: DEPLOYER });
    } catch (error) {
      return error;
    }
    return null;
  };
  expect(createWithoutKey()).toMatchObject({ code: "NAN_PROVIDER_ERROR" });

  const createWithNoEnv = (): unknown => {
    try {
      createNanBridge({}, { learnerOwnerId: DEPLOYER });
    } catch (error) {
      return error;
    }
    return null;
  };
  expect(createWithNoEnv()).toMatchObject({ code: "NAN_PROVIDER_ERROR" });
});
