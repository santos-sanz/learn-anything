import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TextEncoder as NodeTextEncoder } from "node:util";

import type { TestConvexForDataModel } from "convex-test";

import { api } from "../../../api/convex/_generated/api.js";
import type { DataModel, Id } from "../../../api/convex/_generated/dataModel.js";
import { decodeAccessToken, EMAIL, PASSWORD, TEST_ISSUER } from "../../../api/tests/helpers/authEnv.js";
import { makeConvexDocumentsBackend, type DocumentsBackend } from "../../src/data/documents.js";
import { makeConvexProjectsBackend, type ProjectsBackend } from "../../src/data/projects.js";
import type { AuthSession } from "../../src/Root.js";
import { asConvexClient } from "../fixtures.js";
import { convexVoicePorts, type ChatBehaviour } from "./voiceConversation.js";

/**
 * Shared S26 release-acceptance harness: one convex-test deployment whose
 * identity is resolved per call, so a journey can start anonymous, sign in
 * through the real Convex Auth `signIn` action, and keep every backend
 * (projects, documents, conversation, HTTP actions) bound to the identity the
 * UI currently holds. No deployment, credential or network is involved.
 */

/** The concrete convex-test instance for this repo's schema (identity and anonymous share it). */
export type TestInstance = TestConvexForDataModel<DataModel>;

export const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });

/**
 * A convex-test instance whose identity is decided at call time. It keeps
 * convex-test's own typed `query`/`mutation`/`action` signatures, so callers
 * get real result types through the proxy.
 */
export type DynamicClient = Pick<TestInstance, "query" | "mutation" | "action" | "fetch"> & {
  /** The signed-in subject ("userId|sessionId"), null while anonymous. */
  subject: { current: string | null };
  /** The owner id behind the current subject (null while anonymous). */
  ownerId(): string | null;
  /** The bare instance resolved for the current subject. */
  instance(): TestInstance;
};

export function dynamicClient(t: TestInstance): DynamicClient {
  const subject: { current: string | null } = { current: null };
  const instance = (): TestInstance => (subject.current === null ? t : t.withIdentity(identity(subject.current)));
  return {
    query: (fn, ...args) => instance().query(fn, ...args),
    mutation: (fn, ...args) => instance().mutation(fn, ...args),
    action: (fn, ...args) => instance().action(fn, ...args),
    fetch: (path, init) => instance().fetch(path, init),
    subject,
    ownerId(): string | null {
      return subject.current === null ? null : subject.current.split("|")[0];
    },
    instance,
  };
}

export type ReleaseSessionState = { authenticated: boolean };

const NodeUint8Array = new NodeTextEncoder().encode("").constructor as Uint8ArrayConstructor;

/**
 * Runs `work` with the global `Uint8Array` temporarily bound to Node's
 * constructor. jsdom installs its own realm's `Uint8Array` as the global
 * while `TextEncoder` stays Node's, so Convex Auth's JWT signing (`jose`)
 * would reject its own Node-realm payload with "payload must be an instance
 * of Uint8Array". Only the auth actions run inside the window — they never
 * touch the DOM — and the previous descriptor is restored afterwards, so
 * the rest of a jsdom test keeps the realm it was given.
 */
async function withNodeUint8Array<T>(work: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Uint8Array");
  Object.defineProperty(globalThis, "Uint8Array", { value: NodeUint8Array, configurable: true, writable: true });
  try {
    return await work();
  } finally {
    if (descriptor !== undefined) Object.defineProperty(globalThis, "Uint8Array", descriptor);
  }
}

/**
 * A real Convex Auth session: `signIn` calls the deployed `auth.signIn`
 * action with the form values, so credentials are verified by the real
 * password provider and the bound subject comes from the issued token.
 */
export function realAuthSession(client: DynamicClient, state: ReleaseSessionState): AuthSession {
  return {
    isLoading: false,
    get isAuthenticated() {
      return state.authenticated;
    },
    signIn: async (submission) => {
      const result = await withNodeUint8Array(() => client.action(api.auth.signIn, { provider: "password", params: submission }));
      const tokens = (result as { tokens?: { token: string } | null } | null)?.tokens;
      if (tokens === null || tokens === undefined) throw new Error("sign-in was rejected");
      client.subject.current = decodeAccessToken(tokens.token).sub;
      state.authenticated = true;
    },
    signOut: async () => {
      client.subject.current = null;
      state.authenticated = false;
    },
  };
}

export function staticSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return { isLoading: false, isAuthenticated: true, signIn: async () => undefined, signOut: async () => undefined, ...overrides };
}

/**
 * Creates the learner account through the real password sign-up action and
 * returns its owner id, so the single-user provider policy can be pointed at
 * the journey's own learner (never at a real key).
 */
export async function signUpLearner(t: TestInstance, email = EMAIL, password = PASSWORD): Promise<string> {
  const result = await withNodeUint8Array(() => t.action(api.auth.signIn, { provider: "password", params: { flow: "signUp", email, password } }));
  const tokens = (result as { tokens?: { token: string } | null } | null)?.tokens;
  if (tokens === null || tokens === undefined) throw new Error("sign-up did not issue tokens");
  return decodeAccessToken(tokens.token).sub.split("|")[0];
}

/** All backends a journey needs, bound to one dynamic identity. */
export function releaseBackends(client: DynamicClient): { projects: ProjectsBackend; documents: DocumentsBackend } {
  return {
    projects: makeConvexProjectsBackend(asConvexClient(client)),
    documents: makeConvexDocumentsBackend(asConvexClient(client), {
      getToken: () => "synthetic-test-token",
      siteUrl: "",
      fetchImpl: (input, init) => client.fetch(input, init),
    }),
  };
}

/** The S17 ports (real STT/tutor/TTS routes) bound to the same identity. */
export function releaseVoicePorts(client: DynamicClient, options?: Parameters<typeof convexVoicePorts>[1]) {
  return convexVoicePorts(client, options);
}

/** Synthetic fixture bytes from the shared corpus (repo-root relative). */
export function fixtureBytes(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(join(process.cwd(), "packages/api/tests/fixtures", name)));
}

export type UploadBody = { documentId: string; privateFileId: string; jobId: string };

/** Uploads one fixture through the real authenticated HTTP action. */
export async function uploadFixture(
  t: TestInstance,
  subject: string | null,
  projectId: string,
  filename: string,
  idempotencyKey: string,
): Promise<UploadBody> {
  const contentType = filename.endsWith(".pdf") ? "application/pdf" : filename.endsWith(".md") ? "text/markdown" : "text/plain";
  const client = subject === null ? t : t.withIdentity(identity(subject));
  const path = `/private-uploads?projectId=${encodeURIComponent(projectId)}&filename=${encodeURIComponent(filename)}&idempotencyKey=${encodeURIComponent(idempotencyKey)}`;
  const response = await client.fetch(path, {
    method: "POST",
    body: fixtureBytes(filename) as unknown as BodyInit,
    headers: { "content-type": contentType },
  });
  if (response.status !== 201) throw new Error(`upload ${filename} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as UploadBody;
}

/** Counts rows in a table of the shared deployment. */
export async function countRows(t: TestInstance, table: string): Promise<number> {
  const rows = await t.run(async (ctx) => ctx.db.query(table as never).collect());
  return rows.length;
}

/** Every row of a table, typed loosely for assertions. */
export async function allRows<T>(t: TestInstance, table: string): Promise<T[]> {
  return (await t.run(async (ctx) => ctx.db.query(table as never).collect())) as T[];
}

/**
 * The no-duplicate invariant every S26 failure scenario asserts: turn ids are
 * unique and each turn owns at most one learner and one tutor message.
 */
export function expectNoDuplicateTurns(
  turns: Array<{ turnId: string; status?: string }>,
  messages: Array<{ turnId: string; role: string; idempotencyKey?: string }>,
): { distinctTurnIds: number; completedTurns: number } {
  const distinctTurnIds = new Set(turns.map((turn) => turn.turnId)).size;
  if (distinctTurnIds !== turns.length) throw new Error(`duplicate turn rows: ${turns.map((turn) => turn.turnId).join(", ")}`);
  const keys = messages.map((message) => message.idempotencyKey).filter((key): key is string => key !== undefined);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate message idempotency keys");
  for (const turn of turns) {
    const owned = messages.filter((message) => message.turnId === turn.turnId);
    const learners = owned.filter((message) => message.role === "learner").length;
    const tutors = owned.filter((message) => message.role === "tutor").length;
    if (learners > 1 || tutors > 1) throw new Error(`turn ${turn.turnId} has ${learners} learner / ${tutors} tutor messages`);
  }
  return { distinctTurnIds, completedTurns: turns.filter((turn) => turn.status === "completed").length };
}

export type { ChatBehaviour, Id };
