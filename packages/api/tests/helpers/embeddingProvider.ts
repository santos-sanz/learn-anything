/**
 * Offline NaN embeddings mock for ingestion tests. It answers `/embeddings`
 * with deterministic synthetic 4096-dimensional vectors and throws on any
 * other provider URL, so a test can never silently reach the network or a
 * different NaN stage. `installEmbeddingProvider` returns a restore function
 * that also rolls the environment back to its previous key/deployer values.
 */

export const SYNTHETIC_NAN_KEY = "synthetic-test-key";

/** Deterministic finite vector; same seed always yields the same row. */
export function syntheticEmbeddingVector(seed: number, dimensions = 4096): number[] {
  return Array.from({ length: dimensions }, (_, index) => Math.sin(seed * 997 + index * 0.017));
}

type EmbeddingResponseBody = { model: string; data: Array<{ embedding: number[] }> };

export function embeddingResponse(inputs: unknown, dimensions = 4096): Response {
  const texts = Array.isArray(inputs) ? inputs : [];
  const body: EmbeddingResponseBody = {
    model: "qwen3-embedding",
    data: texts.map((_, index) => ({ embedding: syntheticEmbeddingVector(index + 1, dimensions) })),
  };
  return Response.json(body);
}

export function installEmbeddingProvider(deployerId: string): () => void {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.NAN_API_KEY;
  const previousDeployer = process.env.NAN_DEPLOYER_ID;
  process.env.NAN_API_KEY = SYNTHETIC_NAN_KEY;
  process.env.NAN_DEPLOYER_ID = deployerId;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/embeddings")) throw new Error(`offline test attempted an unexpected provider call: ${url}`);
    const body = JSON.parse(String(init?.body)) as { input?: unknown };
    return embeddingResponse(body.input);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.NAN_API_KEY;
    else process.env.NAN_API_KEY = previousKey;
    if (previousDeployer === undefined) delete process.env.NAN_DEPLOYER_ID;
    else process.env.NAN_DEPLOYER_ID = previousDeployer;
  };
}
