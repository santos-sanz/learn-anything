import { expect, test } from "vitest";

import { AgentError } from "../src/errors.js";
import { assertUsableBridgeSession, deriveInstanceId, parseBridgeSession, signBridgeSession, type BridgeSession } from "../src/scope.js";

const SECRET = "test-not-a-real-bridge-secret";
const OWNER = "user_owner_1";
const PROJECT = "proj_owner_1_scope";

test("instance ids are deterministic, owner/project scoped and never embed identifiers", async () => {
  const instanceId = await deriveInstanceId(SECRET, OWNER, PROJECT);
  expect(instanceId).toMatch(/^la_[0-9a-f]{32}$/);
  expect(await deriveInstanceId(SECRET, OWNER, PROJECT)).toBe(instanceId);
  expect(await deriveInstanceId(SECRET, OWNER, "proj_owner_1_other_scope")).not.toBe(instanceId);
  expect(await deriveInstanceId(SECRET, "user_owner_2", PROJECT)).not.toBe(instanceId);
  expect(await deriveInstanceId("a-different-bridge-secret", OWNER, PROJECT)).not.toBe(instanceId);
  for (const readable of [OWNER, "user", PROJECT, "proj", "owner"]) {
    expect(instanceId).not.toContain(readable);
  }
});

test("an empty bridge secret refuses derivation with a visible configuration error", async () => {
  await expect(deriveInstanceId("", OWNER, PROJECT)).rejects.toMatchObject({ code: "AGENT_NOT_CONFIGURED" });
});

test("bridge sessions round-trip and fail closed on any tampering", async () => {
  const session: BridgeSession = { token: "connection-token-value", ownerId: OWNER, projectId: PROJECT, instanceId: await deriveInstanceId(SECRET, OWNER, PROJECT), verifiedAt: 1_000, expiresAt: 9_000 };
  const header = await signBridgeSession(SECRET, session);
  expect(header).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  expect(await parseBridgeSession(SECRET, header)).toEqual(session);

  expect(await parseBridgeSession(SECRET, null)).toBeNull();
  expect(await parseBridgeSession(SECRET, "")).toBeNull();
  expect(await parseBridgeSession(SECRET, "not-a-bridge-header")).toBeNull();
  expect(await parseBridgeSession("wrong-secret-value", header)).toBeNull();

  const [body, signature] = header.split(".");
  const tamperedBody = Buffer.from(JSON.stringify({ ...session, ownerId: "user_owner_2" })).toString("base64url");
  expect(await parseBridgeSession(SECRET, `${tamperedBody}.${signature}`)).toBeNull();
  const tamperedSignature = `${body}.${"0".repeat(63)}1`;
  expect(await parseBridgeSession(SECRET, tamperedSignature)).toBeNull();
});

test("session assertions reject foreign scopes, mismatches and expiry", async () => {
  const session: BridgeSession = { token: "t", ownerId: OWNER, projectId: PROJECT, instanceId: await deriveInstanceId(SECRET, OWNER, PROJECT), verifiedAt: Date.now(), expiresAt: Date.now() + 60_000 };
  await expect(assertUsableBridgeSession(SECRET, session.instanceId, session)).resolves.toBeUndefined();

  const foreign: BridgeSession = { ...session, instanceId: await deriveInstanceId(SECRET, "user_owner_2", PROJECT) };
  await expect(assertUsableBridgeSession(SECRET, session.instanceId, foreign)).rejects.toMatchObject({ code: "AGENT_SCOPE_MISMATCH", httpStatus: 403 });

  const expired: BridgeSession = { ...session, expiresAt: Date.now() - 1 };
  await expect(assertUsableBridgeSession(SECRET, session.instanceId, expired)).rejects.toMatchObject({ code: "AGENT_SESSION_EXPIRED", httpStatus: 401 });

  await expect(assertUsableBridgeSession(SECRET, "la_ffffffffffffffffffffffffffffffff", session)).rejects.toMatchObject({ code: "AGENT_SCOPE_MISMATCH" });

  await assertUsableBridgeSession(SECRET, session.instanceId, session).catch((error: unknown) => {
    expect(error).toBeInstanceOf(AgentError);
  });
});
