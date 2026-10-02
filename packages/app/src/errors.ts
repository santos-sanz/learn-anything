import { ConvexError } from "convex/values";

/** Thrown by the client when the bounded delete loop exhausts its batch cap; the cleanup stays resumable. */
export const DELETION_INCOMPLETE = "DELETION_INCOMPLETE";

/** Typed Convex error codes travel in `error.data`; message fallback covers older shapes. */
export function dataErrorCode(error: unknown): string | null {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "object" && data !== null && "code" in data && typeof (data as { code: unknown }).code === "string") {
      return (data as { code: string }).code;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  for (const code of ["UNAUTHENTICATED", "NOT_FOUND", "INVALID_ARGUMENT", DELETION_INCOMPLETE]) {
    if (message.includes(code)) return code;
  }
  return null;
}
