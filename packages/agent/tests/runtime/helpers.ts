import { exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";

import { AGENT_SESSION_PATH } from "../../src/routes.js";
import { network } from "./network.js";

export const TEST_OWNER_ONE = "user_owner_1";
export const TEST_OWNER_TWO = "user_owner_2";
export const TEST_PROJECT_ONE = "proj_owner_1_scope";
export const TEST_PROJECT_TWO = "proj_owner_2_scope";

export const AGENT_ORIGIN = "https://agent.test";
export const CONVEX_ORIGIN = "https://convex.test";
export const NAN_COMPLETIONS_URL = "https://api.nan.builders/v1/chat/completions";
export const MOCK_TUTOR_REPLY = "Mocked NaN tutor reply.";

export type MockTokenRecord = {
  token: string;
  ownerId: string;
  projectId: string;
  expiresAt: number;
  revoked: boolean;
};

export type ConvexMock = {
  registry: Map<string, MockTokenRecord>;
  revoke: (token: string) => void;
  issue: (record: Omit<MockTokenRecord, "revoked" | "expiresAt"> & { expiresAt?: number }) => MockTokenRecord;
};

function successBody(record: MockTokenRecord, rotated: boolean, replacement?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ok: true,
    tokenId: `token_id_${record.token.slice(0, 8)}`,
    ownerId: record.ownerId,
    projectId: record.projectId,
    issuedAt: Date.now() - 1_000,
    expiresAt: record.expiresAt,
    verifyCount: 1,
    rotated,
  };
  if (replacement !== undefined) body.token = replacement;
  return body;
}

/**
 * Installs MSW handlers standing in for the S06 Convex HTTP routes and the
 * NaN chat endpoint (verify, reconnect-with-rotation and tutor completions).
 * The returned registry models the real contract: unknown tokens are forged,
 * revoked/rotated tokens are rejected as replays, expired tokens are rejected.
 * Nothing here touches the network.
 */
export function installConvexMock(seed: Array<Omit<MockTokenRecord, "revoked" | "expiresAt"> & { expiresAt?: number }>): ConvexMock {
  const registry = new Map<string, MockTokenRecord>();
  const issue: ConvexMock["issue"] = (record) => {
    const stored: MockTokenRecord = {
      token: record.token,
      ownerId: record.ownerId,
      projectId: record.projectId,
      expiresAt: record.expiresAt ?? Date.now() + 300_000,
      revoked: false,
    };
    registry.set(stored.token, stored);
    return stored;
  };
  for (const record of seed) issue(record);

  const evaluate = (token: string): { record?: MockTokenRecord; code?: string } => {
    const record = registry.get(token);
    if (record === undefined) return { code: "CONNECTION_TOKEN_INVALID" };
    if (record.revoked) return { code: "CONNECTION_TOKEN_REVOKED" };
    if (Date.now() >= record.expiresAt) return { code: "CONNECTION_TOKEN_EXPIRED" };
    return { record };
  };

  network.use(
    http.post(`${CONVEX_ORIGIN}/agent/connection-tokens/verify`, async ({ request }) => {
      const body = (await request.json()) as { token?: unknown };
      if (typeof body.token !== "string") return HttpResponse.json({ code: "INVALID_BODY" }, { status: 400 });
      const verdict = evaluate(body.token);
      if (verdict.record === undefined) return HttpResponse.json({ code: verdict.code }, { status: 401 });
      return HttpResponse.json(successBody(verdict.record, false));
    }),
    http.post(`${CONVEX_ORIGIN}/agent/connection-tokens/reconnect`, async ({ request }) => {
      const body = (await request.json()) as { token?: unknown };
      if (typeof body.token !== "string") return HttpResponse.json({ code: "INVALID_BODY" }, { status: 400 });
      const verdict = evaluate(body.token);
      if (verdict.record === undefined) return HttpResponse.json({ code: verdict.code }, { status: 401 });
      const previous = verdict.record;
      previous.revoked = true;
      const replacement = issue({ token: `${previous.token}_rotated`, ownerId: previous.ownerId, projectId: previous.projectId, expiresAt: Date.now() + 300_000 });
      return HttpResponse.json(successBody(previous, true, replacement.token));
    }),
    http.post(NAN_COMPLETIONS_URL, () =>
      HttpResponse.json({ choices: [{ message: { content: MOCK_TUTOR_REPLY } }] }),
    ),
  );

  return {
    registry,
    revoke: (token) => {
      const record = registry.get(token);
      if (record !== undefined) record.revoked = true;
    },
    issue,
  };
}

export type Frame = Record<string, unknown> & { type: string };

export async function postSession(body: Record<string, unknown>): Promise<Response> {
  return exports.default.fetch(
    new Request(`${AGENT_ORIGIN}${AGENT_SESSION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function startSession(token: string): Promise<{ instanceId: string; connectPath: string; expiresAt: number }> {
  const response = await postSession({ token });
  const payload = (await response.json()) as { instanceId?: string; connectPath?: string; expiresAt?: number; code?: string; message?: string };
  expect(response.status, `session endpoint failed: ${JSON.stringify(payload)}`).toBe(200);
  expect(payload.instanceId, JSON.stringify(payload)).toMatch(/^la_[0-9a-f]{32}$/);
  expect(payload.connectPath).toContain(payload.instanceId);
  return { instanceId: payload.instanceId!, connectPath: payload.connectPath!, expiresAt: payload.expiresAt! };
}

export type TestConnection = {
  send: (message: Record<string, unknown>) => void;
  next: (type: string, timeoutMs?: number) => Promise<Frame>;
  close: () => void;
};

/** Opens a gated WebSocket through the real Worker + Durable Object. */
export async function connectAgent(connectPath: string, token: string): Promise<TestConnection> {
  const response = await exports.default.fetch(
    new Request(`${AGENT_ORIGIN}${connectPath}?token=${encodeURIComponent(token)}`, { headers: { Upgrade: "websocket" } }),
  );
  const body = response.status === 101 ? "" : await response.text().catch(() => "");
  expect(response.status, `upgrade failed: ${response.status} ${body}`).toBe(101);
  const socket = response.webSocket;
  expect(socket).toBeTruthy();
  socket!.accept();

  const backlog: Frame[] = [];
  const waiters: Array<{ type: string; resolve: (frame: Frame) => void }> = [];
  socket!.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    const frame = JSON.parse(event.data) as Frame;
    const index = waiters.findIndex((waiter) => waiter.type === frame.type || waiter.type === "*");
    if (index >= 0) waiters.splice(index, 1)[0].resolve(frame);
    else backlog.push(frame);
  });

  return {
    send: (message) => socket!.send(JSON.stringify(message)),
    next: (type, timeoutMs = 5_000) => {
      const existing = backlog.findIndex((frame) => frame.type === type || type === "*");
      if (existing >= 0) return Promise.resolve(backlog.splice(existing, 1)[0]);
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => {
          const waitIndex = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (waitIndex >= 0) waiters.splice(waitIndex, 1);
          reject(new Error(`timed out waiting for frame "${type}"; received: ${JSON.stringify(backlog)}`));
        }, timeoutMs);
        waiters.push({
          type,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
    close: () => socket!.close(1000, "test complete"),
  };
}
