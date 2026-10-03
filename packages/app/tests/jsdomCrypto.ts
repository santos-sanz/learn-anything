import { createHash, webcrypto } from "node:crypto";

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
 *
 * The installed `subtle` also proxies every other WebCrypto operation
 * (PBKDF2 `importKey`/`deriveBits`, …) to Node's own implementation, which
 * the real Convex Auth password provider needs for credential hashing in
 * jsdom; only `digest` stays realm-local, because Node's WebCrypto can
 * reject jsdom-realm buffers there.
 */
export function ensureSubtleCrypto(): void {
  const target = globalThis.crypto as { subtle?: unknown } | undefined;
  if (target === undefined) return;
  const digest = async (_algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const hash = createHash("sha256").update(bytes).digest();
    return new Uint8Array(hash).buffer;
  };
  const subtle = new Proxy(webcrypto.subtle, {
    get(proxyTarget, property, receiver) {
      if (property === "digest") return digest;
      const value = Reflect.get(proxyTarget, property, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(proxyTarget) : value;
    },
  });
  // Installed unconditionally: whether the exposed `subtle` is jsdom's
  // missing one or Node's (which can reject jsdom-realm buffers on some
  // runners), the syscall only ever asks for SHA-256.
  try {
    Object.defineProperty(target, "subtle", { value: subtle, configurable: true });
  } catch {
    // A frozen crypto object would already have failed the upload visibly.
  }
}
