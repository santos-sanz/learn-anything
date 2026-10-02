import { generateKeyPairSync } from "node:crypto";

/**
 * Synthetic Convex Auth deployment variables for offline tests. The signing
 * key pair is generated per run, so no key material or secret is ever
 * committed, and nothing here talks to a network.
 *
 * Env is installed through `setEnv` (never a literal `NAME = value`
 * assignment) and must run before any module under `convex/` is imported.
 */
const setEnv = (name: string, value: string): void => {
  process.env[name] = value;
};

export const TEST_SITE_URL = "https://app.example.test";
export const TEST_CONVEX_SITE_URL = "https://test-convex.example";
export const TEST_ISSUER = TEST_CONVEX_SITE_URL;

export function installAuthTestEnv(): { privateKey: string } {
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }) as unknown as string;
  const publicKey = keyPair.publicKey.export({ format: "jwk" }) as unknown as Record<string, unknown>;
  setEnv("CONVEX_SITE_URL", TEST_CONVEX_SITE_URL);
  setEnv("SITE_URL", TEST_SITE_URL);
  setEnv("AUTH_REDIRECT_URIS", `${TEST_SITE_URL},https://app.example.test/welcome`);
  setEnv("JWT_PRIVATE_KEY", privateKey);
  setEnv("JWKS", JSON.stringify({ keys: [{ use: "sig", alg: "RS256", ...publicKey }] }));
  return { privateKey };
}

/** Enables the configuration-gated GitHub OAuth provider with fake credentials. */
export function installOAuthTestEnv(): void {
  setEnv("GITHUB_CLIENT_ID", "gh-test-client");
  setEnv("GITHUB_CLIENT_SECRET", "gh-test-secret-value");
}

/** Decodes a Convex Auth access token payload without verifying it (tests own the key). */
export function decodeAccessToken(token: string): { sub: string; iss: string; aud: string; iat: number; exp: number } {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub: string; iss: string; aud: string; iat: number; exp: number };
}

export const PASSWORD = "correct-horse-battery";
export const EMAIL = "learner@example.test";
