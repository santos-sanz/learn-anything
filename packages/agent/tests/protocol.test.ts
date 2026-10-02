import { expect, test } from "vitest";

import { isSdkControlFrame, MAX_CLIENT_MESSAGE_BYTES, MAX_TURN_TEXT_CHARACTERS, parseClientMessage } from "../src/protocol.js";

test("parses the supported control messages", () => {
  expect(parseClientMessage(JSON.stringify({ type: "ping" }))).toEqual({ type: "ping" });
  expect(parseClientMessage(JSON.stringify({ type: "state.read" }))).toEqual({ type: "state.read" });
  expect(parseClientMessage(JSON.stringify({ type: "tutor.turn", turnId: "turn-1", text: "hola" }))).toEqual({ type: "tutor.turn", turnId: "turn-1", text: "hola" });
});

test("refuses malformed, unknown or oversized messages", () => {
  expect(parseClientMessage("")).toBeNull();
  expect(parseClientMessage("{not json")).toBeNull();
  expect(parseClientMessage(JSON.stringify("a string"))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ type: "unknown.op" }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ type: "tutor.turn", turnId: "", text: "hola" }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ type: "tutor.turn", turnId: "turn-1", text: "" }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ type: "tutor.turn", turnId: "x".repeat(129), text: "hola" }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ type: "tutor.turn", turnId: "turn-1", text: "x".repeat(MAX_TURN_TEXT_CHARACTERS + 1) }))).toBeNull();
  expect(parseClientMessage(`{"type":"ping"}${"x".repeat(MAX_CLIENT_MESSAGE_BYTES)}`)).toBeNull();
});

test("recognises Agents SDK control frames so they are not treated as client input", () => {
  expect(isSdkControlFrame(JSON.stringify({ type: "cf_agent_state", value: 1 }))).toBe(true);
  expect(isSdkControlFrame(JSON.stringify({ type: "cf_agent_history", value: 1 }))).toBe(true);
  expect(isSdkControlFrame(JSON.stringify({ type: "ping" }))).toBe(false);
  expect(isSdkControlFrame("not json with cf_ inside")).toBe(false);
});
