/**
 * S06 callback allowlist for Convex Auth redirects (OAuth callback and magic
 * links). Only exact configured http(s) redirect URIs are accepted: wildcard
 * patterns, other origins and unconfigured targets are rejected before any
 * redirect is issued. Configuration is read from `AUTH_REDIRECT_URIS`
 * (comma-separated) plus `SITE_URL`, which is the deployment's own site and is
 * always allowed when set.
 */

export type RedirectAllowlistEnv = {
  AUTH_REDIRECT_URIS?: string | undefined;
  SITE_URL?: string | undefined;
};

const SEPARATOR = ",";

/** Normalizes one configured entry; wildcard or non-http(s) entries are dropped. */
function normalizeRedirectUri(entry: string): string | null {
  if (entry.includes("*")) return null;
  try {
    const url = new URL(entry);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Parses a comma-separated allowlist. Invalid entries are dropped, never widened. */
export function parseRedirectAllowlist(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const normalized = new Set<string>();
  for (const entry of raw.split(SEPARATOR)) {
    const uri = normalizeRedirectUri(entry.trim());
    if (uri !== null) normalized.add(uri);
  }
  return [...normalized];
}

/** Reads the allowlist from deployment environment variables. */
export function readRedirectAllowlist(env: RedirectAllowlistEnv): string[] {
  const allowlist = parseRedirectAllowlist(env.AUTH_REDIRECT_URIS);
  const site = normalizeRedirectUri((env.SITE_URL ?? "").trim());
  if (site !== null && !allowlist.includes(site)) allowlist.push(site);
  return allowlist;
}

/**
 * Resolves `redirectTo` to an absolute http(s) URL and requires an exact
 * allowlist match. Relative paths resolve against `baseUrl` (`SITE_URL`) and
 * are then subject to the same exact match, so a path that is not configured
 * is rejected as well.
 */
export function resolveRedirectTarget(redirectTo: unknown, allowlist: readonly string[], baseUrl: string | undefined): string {
  if (typeof redirectTo !== "string" || redirectTo.trim() === "") throw new Error("REDIRECT_NOT_ALLOWED: redirect target is missing");
  if (redirectTo.includes("*")) throw new Error("REDIRECT_NOT_ALLOWED: wildcard redirect targets are not allowed");
  if (redirectTo.includes("\\")) throw new Error("REDIRECT_NOT_ALLOWED: malformed redirect target");
  const base = baseUrl === undefined || baseUrl.trim() === "" ? allowlist[0] : baseUrl.trim();
  if (base === undefined) throw new Error("REDIRECT_NOT_ALLOWED: no redirect URI is configured");
  let target: URL;
  try {
    target = new URL(redirectTo, base);
  } catch {
    throw new Error("REDIRECT_NOT_ALLOWED: redirect target is not a valid URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("REDIRECT_NOT_ALLOWED: only http(s) redirect targets are allowed");
  const resolved = target.toString();
  if (!allowlist.includes(resolved)) throw new Error("REDIRECT_NOT_ALLOWED: redirect target is not in the configured allowlist");
  return resolved;
}

/** The Convex Auth `callbacks.redirect` implementation for this repository. */
export async function redirectCallback(params: { redirectTo: unknown }, env: RedirectAllowlistEnv = process.env as RedirectAllowlistEnv): Promise<string> {
  return resolveRedirectTarget(params.redirectTo, readRedirectAllowlist(env), env.SITE_URL);
}
