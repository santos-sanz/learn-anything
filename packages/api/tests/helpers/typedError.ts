import { expect } from "vitest";

/**
 * Asserts that a rejected Convex function call carries the typed `{ code }`
 * inside its `ConvexError` data. Matching the message text is deliberately not
 * enough: the typed code is the contract HTTP routes, the web client and the
 * agent runtime map on, so a denial that only "throws" is not evidence.
 */
export async function expectTypedCode(call: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown = null;
  let rejected = false;
  try {
    await call;
  } catch (error) {
    rejected = true;
    caught = error;
  }
  expect(rejected, `expected a rejection with typed code ${code}`).toBe(true);
  const data = (caught as { data?: unknown } | null)?.data;
  const actual = typeof data === "object" && data !== null ? (data as { code?: unknown }).code : undefined;
  expect(actual, `expected ConvexError data.code ${code}, got ${String(actual)}`).toBe(code);
}
