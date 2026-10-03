import { NanClient, type NanFetch, type NanMessage } from "@learn-anything/worker";

/**
 * The server-side NaN provider bridge for the agent runtime (S07 minimal call
 * path over the S11 adapters in `packages/worker`). Every capability — LLM,
 * speech, embeddings and rerank — goes through `NanClient`, which pins the
 * NaN base URL, models and the personal-key deployment policy. There is no
 * Workers AI binding, import or fallback anywhere in this package: the
 * wrangler configuration has no `ai` field and this bridge has no other
 * provider branch.
 */
export type NanBridgeEnv = {
  NAN_API_KEY?: string;
  NAN_DEPLOYER_ID?: string;
};

export type NanBridgeContext = {
  /** Verified owner of the session invoking the bridge; used for key policy. */
  learnerOwnerId: string;
};

export type NanBridge = {
  tutor: (text: string) => Promise<string>;
  speech: (text: string) => Promise<Uint8Array>;
  embeddings: (inputs: string[]) => Promise<number[][]>;
  rerank: (query: string, documents: string[]) => Promise<Array<{ index: number; relevanceScore: number }>>;
};

export function createNanBridge(env: NanBridgeEnv, context: NanBridgeContext, fetchImpl?: NanFetch): NanBridge {
  const client = new NanClient({
    apiKey: env.NAN_API_KEY ?? "",
    fetch: fetchImpl,
    deployment: {
      mode: "single-user-self-hosted",
      learnerId: context.learnerOwnerId,
      deployerId: env.NAN_DEPLOYER_ID ?? "",
    },
  });
  const messages: NanMessage[] = [
    {
      role: "system",
      content:
        "You are a private learning tutor. Answer clearly and concisely. Retrieval over the learner's documents is not wired up yet; say so instead of inventing sources.",
    },
  ];
  return {
    tutor: (text: string) => client.tutor([...messages, { role: "user", content: text }]),
    speech: (text: string) => client.speech(text),
    embeddings: async (inputs: string[]) => (await client.embeddings(inputs)).vectors,
    rerank: (query: string, documents: string[]) => client.rerank(query, documents),
  };
}
