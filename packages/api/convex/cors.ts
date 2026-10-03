import { httpAction } from "./_generated/server";

/**
 * S15 CORS for browser calls to the `.convex.site` HTTP actions. This is the
 * first cross-origin browser request in this codebase: the STT client sends
 * `Authorization: Bearer …` and `content-type: audio/webm`, so the browser
 * always sends a preflight `OPTIONS` first and every real response must carry
 * `Access-Control-Allow-Origin` before the page may read its body. Convex does
 * not add any of this for you — see https://docs.convex.dev/functions/http-actions#cors
 * (the preflight handler and the response headers are both the app's job).
 *
 * The allowlist is deployment configuration only: `SITE_URL` plus the origins
 * of `AUTH_REDIRECT_URIS`, the same trusted variables the S06 redirect
 * allowlist already uses. An origin that is not configured is never echoed
 * back, and no wildcard is ever combined with `Authorization`.
 */

export type CorsEnv = {
  AUTH_REDIRECT_URIS?: string | undefined;
  SITE_URL?: string | undefined;
};

/** Methods and headers the STT client sends; the preflight answer matches them exactly. */
export const CORS_ALLOWED_METHODS = "POST, OPTIONS";
export const CORS_ALLOWED_HEADERS = "Authorization, Content-Type";
export const CORS_MAX_AGE_SECONDS = 86_400;

const SEPARATOR = ",";

/** Normalizes one configured entry to a bare origin; wildcards and non-http(s) entries are dropped. */
function normalizeOrigin(entry: string): string | null {
  if (entry.includes("*")) return null;
  try {
    const url = new URL(entry);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Reads the allowed browser origins from `SITE_URL` and the comma-separated `AUTH_REDIRECT_URIS`. */
export function readCorsAllowlist(env: CorsEnv = process.env as CorsEnv): string[] {
  const entries = [env.SITE_URL ?? "", ...(env.AUTH_REDIRECT_URIS ?? "").split(SEPARATOR)];
  const allowlist = new Set<string>();
  for (const entry of entries) {
    const origin = normalizeOrigin(entry.trim());
    if (origin !== null) allowlist.add(origin);
  }
  return [...allowlist];
}

/** Exact-match only: a foreign or malformed `Origin` resolves to null and is never echoed back. */
export function allowedOrigin(origin: string | null, allowlist: readonly string[]): string | null {
  if (origin === null) return null;
  const normalized = normalizeOrigin(origin.trim());
  if (normalized === null) return null;
  return allowlist.includes(normalized) ? normalized : null;
}

/** `Vary: origin` on every response; `Access-Control-Allow-Origin` only for a configured origin. */
export function corsHeaders(origin: string | null, allowlist: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = { Vary: "origin" };
  const allowed = allowedOrigin(origin, allowlist);
  if (allowed !== null) headers["Access-Control-Allow-Origin"] = allowed;
  return headers;
}

/**
 * Preflight answer for a browser route: `204`, no authentication and no body,
 * with the methods and headers the client asked for plus a cache lifetime. The
 * allow-origin header is only present when the requesting origin is configured,
 * so the browser blocks any other origin instead of being told it may read the
 * response.
 */
export const corsPreflightRoute = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("Origin");
  const headers = new Headers(corsHeaders(origin, readCorsAllowlist()));
  if (origin !== null && request.headers.get("Access-Control-Request-Method") !== null) {
    headers.set("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
    headers.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
    headers.set("Access-Control-Max-Age", String(CORS_MAX_AGE_SECONDS));
  }
  return new Response(null, { status: 204, headers });
});
