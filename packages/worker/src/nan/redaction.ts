/** Keeps credentials out of diagnostics; never pass request bodies to logging. */
export function redactNanSecret(value: string): string {
  return value.replace(/\b(?:sk|nan)_[A-Za-z0-9_-]+\b/gi, "[REDACTED_NAN_KEY]");
}

export function redactNanHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new Headers(headers)) {
    result[key.toLowerCase() === "authorization" ? "Authorization" : key] = key.toLowerCase() === "authorization" ? "Bearer [REDACTED_NAN_KEY]" : value;
  }
  return result;
}
