/** v0.1 recording budget; S15 keeps every turn at or below 60 seconds. */
export const MAX_RECORDING_SECONDS = 60;
export const MAX_RECORDING_MS = MAX_RECORDING_SECONDS * 1000;
/** Stays below both the Convex 20 MiB HTTP-action ceiling and the NaN 25 MiB provider cap. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const SILENCE_PEAK_THRESHOLD = 0.02;
export const RECORDING_TICK_MS = 250;

export type TurnLanguage = "en" | "es";
export const TURN_LANGUAGES: readonly TurnLanguage[] = ["en", "es"];

export type CaptureBlockReason = "permission-denied" | "no-microphone" | "unsupported-codec";

/** Compressed containers only; the browser records, it never transcodes. */
export const RECORDER_MIME_CANDIDATES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

export function chooseRecorderMimeType(isTypeSupported: (type: string) => boolean): string | null {
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    if (isTypeSupported(candidate)) return candidate;
  }
  return null;
}

/** Maps capture-time failures to actionable states without echoing engine internals. */
export function classifyCaptureFailure(name: string | undefined): CaptureBlockReason {
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "permission-denied";
  return "no-microphone";
}

export function isSilentPeak(peak: number): boolean {
  return peak < SILENCE_PEAK_THRESHOLD;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * HTTP actions live on the deployment's `.convex.site` origin while the
 * Convex client uses `.convex.cloud`. Deriving one origin from the other only
 * picks the URL: the page itself (the Vite dev server in development, the
 * deployed app in production) is always cross-origin to `.convex.site`, so the
 * browser applies CORS — the `Authorization` header forces a preflight
 * `OPTIONS`, and `convex/cors.ts` allows only origins configured through
 * `SITE_URL`/`AUTH_REDIRECT_URIS`. An explicit override wins.
 */
export function resolveConvexSiteUrl(convexUrl: string | undefined, override?: string | undefined): string {
  const trimmedOverride = (override ?? "").trim();
  if (trimmedOverride !== "") return trimmedOverride.replace(/\/+$/, "");
  const trimmed = (convexUrl ?? "").trim().replace(/\/+$/, "");
  return trimmed.replace(/\.convex\.cloud$/, ".convex.site");
}
