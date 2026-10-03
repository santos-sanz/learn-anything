import { expect, test } from "vitest";

import { initialPlayerState, playerMessage, reducePlayer, type PlayerState } from "../src/playerState.js";

const inFlight: PlayerState = { phase: "loading", failure: null };
const playing: PlayerState = { phase: "playing", failure: null };

test("the normal playback lifecycle moves only through legal phases", () => {
  let state = initialPlayerState();
  state = reducePlayer(state, { type: "REQUEST" });
  expect(state.phase).toBe("loading");
  state = reducePlayer(state, { type: "PLAYING" });
  expect(state.phase).toBe("playing");
  state = reducePlayer(state, { type: "PAUSED" });
  expect(state.phase).toBe("paused");
  state = reducePlayer(state, { type: "PLAYING" });
  expect(state.phase).toBe("playing");
  state = reducePlayer(state, { type: "ENDED" });
  expect(state.phase).toBe("ended");
  state = reducePlayer(state, { type: "STOP" });
  expect(state).toEqual(initialPlayerState());
});

test("a cancellation wins over every late event", () => {
  const cancelled = reducePlayer(inFlight, { type: "CANCEL" });
  expect(cancelled.phase).toBe("cancelled");
  // Bytes that arrive after the cancel must not change the state.
  expect(reducePlayer(cancelled, { type: "PLAYING" })).toBe(cancelled);
  expect(reducePlayer(cancelled, { type: "FAILED", code: "network", retryAfterMs: null })).toBe(cancelled);
  expect(reducePlayer(cancelled, { type: "AUTOPLAY_BLOCKED" })).toBe(cancelled);
  expect(reducePlayer(cancelled, { type: "ENDED" })).toBe(cancelled);
  // A stop after a cancel keeps the cancelled explanation instead of hiding it.
  expect(reducePlayer(cancelled, { type: "STOP" })).toBe(cancelled);
  // The next explicit attempt may start over.
  expect(reducePlayer(cancelled, { type: "REQUEST" }).phase).toBe("loading");
});

test("a failure only lands while an attempt is in flight and keeps its typed code", () => {
  const failed = reducePlayer(inFlight, { type: "FAILED", code: "unsupported-voice", retryAfterMs: null });
  expect(failed.phase).toBe("failed");
  expect(failed.failure).toEqual({ code: "unsupported-voice", retryAfterMs: null });
  // A duplicate failure from a superseded attempt never overwrites the state.
  expect(reducePlayer(failed, { type: "FAILED", code: "network", retryAfterMs: null })).toBe(failed);
  expect(reducePlayer(playing, { type: "FAILED", code: "playback", retryAfterMs: 6000 }).failure).toEqual({
    code: "playback",
    retryAfterMs: 6000,
  });
});

test("the blocked-autoplay state offers an actionable alert copy", () => {
  const blocked = reducePlayer(inFlight, { type: "AUTOPLAY_BLOCKED" });
  expect(blocked.phase).toBe("autoplay-blocked");
  const message = playerMessage(blocked);
  expect(message.role).toBe("alert");
  expect(message.text).toContain("user gesture");
  expect(playerMessage({ phase: "failed", failure: { code: "rate-limited", retryAfterMs: 1000 } }).text).toContain("rate limited");
});
