import { expect, test } from "vitest";

import {
  MAX_AUDIO_BYTES,
  MAX_RECORDING_MS,
  MAX_RECORDING_SECONDS,
  RECORDER_MIME_CANDIDATES,
  SILENCE_PEAK_THRESHOLD,
  chooseRecorderMimeType,
  classifyCaptureFailure,
  formatElapsed,
  isSilentPeak,
  resolveConvexSiteUrl,
} from "../src/audioCapture.js";

test("v0.1 recording limits stay within the provider and Convex ceilings", () => {
  expect(MAX_RECORDING_SECONDS).toBeLessThanOrEqual(60);
  expect(MAX_RECORDING_MS).toBe(MAX_RECORDING_SECONDS * 1000);
  expect(MAX_AUDIO_BYTES).toBeLessThan(25 * 1024 * 1024); // NaN provider cap
  expect(MAX_AUDIO_BYTES).toBeLessThan(20 * 1024 * 1024); // Convex HTTP-action ceiling
});

test("a supported compressed recorder format is chosen and none means none", () => {
  expect(chooseRecorderMimeType((type) => type === "audio/webm;codecs=opus")).toBe("audio/webm;codecs=opus");
  expect(chooseRecorderMimeType((type) => type.startsWith("audio/mp4"))).toBe("audio/mp4");
  expect(chooseRecorderMimeType(() => false)).toBeNull();
  expect(RECORDER_MIME_CANDIDATES.every((type) => type.startsWith("audio/"))).toBe(true);
});

test("capture failures classify into actionable reasons", () => {
  expect(classifyCaptureFailure("NotAllowedError")).toBe("permission-denied");
  expect(classifyCaptureFailure("SecurityError")).toBe("permission-denied");
  expect(classifyCaptureFailure("PermissionDeniedError")).toBe("permission-denied");
  expect(classifyCaptureFailure("NotFoundError")).toBe("no-microphone");
  expect(classifyCaptureFailure("NotReadableError")).toBe("no-microphone");
  expect(classifyCaptureFailure(undefined)).toBe("no-microphone");
});

test("silence is decided by peak level against a fixed threshold", () => {
  expect(isSilentPeak(0)).toBe(true);
  expect(isSilentPeak(SILENCE_PEAK_THRESHOLD - 0.001)).toBe(true);
  expect(isSilentPeak(0.3)).toBe(false);
});

test("the elapsed timer formats the configured limit", () => {
  expect(formatElapsed(0)).toBe("00:00");
  expect(formatElapsed(7_400)).toBe("00:07");
  expect(formatElapsed(MAX_RECORDING_MS)).toBe("01:00");
  expect(formatElapsed(69_000)).toBe("01:09");
});

test("the HTTP-actions origin is derived from the deployment URL with an explicit override", () => {
  expect(resolveConvexSiteUrl("https://warm-otter-123.convex.cloud")).toBe("https://warm-otter-123.convex.site");
  expect(resolveConvexSiteUrl("https://warm-otter-123.convex.cloud/")).toBe("https://warm-otter-123.convex.site");
  expect(resolveConvexSiteUrl("http://127.0.0.1:3210")).toBe("http://127.0.0.1:3210");
  expect(resolveConvexSiteUrl("https://ignored.convex.cloud", "https://custom.example/")).toBe("https://custom.example");
  expect(resolveConvexSiteUrl(undefined, "")).toBe("");
});
