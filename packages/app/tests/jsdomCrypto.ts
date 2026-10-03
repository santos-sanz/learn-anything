import { createHash } from "node:crypto";

/**
 * jsdom's `Crypto` implements only `getRandomValues`/`randomUUID`, and on
 * some runners its object shadows Node's global `crypto` (which has
 * `subtle`). convex-test's js storage syscall hashes every stored blob with
 * `crypto.subtle.digest`, so an upload in a jsdom test would fail with an
 * unclassified error (surfacing as HTTP 500 UPLOAD_FAILED) whenever the
 * shadowing happens. This installs a synchronous-equivalent SHA-256 `digest`
 * on the exposed object only when `subtle` is missing; environments that
 * already have WebCrypto are left untouched, and nothing here reaches the
 * network or reads configuration.
 */
export function ensureSubtleCrypto(): void {
  const target = globalThis.crypto as { subtle?: unknown } | undefined;
  if (target === undefined || target.subtle !== undefined) return;
  const digest = async (_algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const hash = createHash("sha256").update(bytes).digest();
    return new Uint8Array(hash).buffer;
  };
  try {
    Object.defineProperty(target, "subtle", { value: { digest }, configurable: true });
  } catch {
    // A frozen crypto object would already have failed the upload visibly.
  }
}
