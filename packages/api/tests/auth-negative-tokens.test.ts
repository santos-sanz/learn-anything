import { createPublicKey, createSign, createVerify, generateKeyPairSync, type JsonWebKey } from "node:crypto";

import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.js";
import { EMAIL, installAuthTestEnv, PASSWORD, TEST_ISSUER } from "./helpers/authEnv.js";
import { expectTypedCode } from "./helpers/typedError.js";

// Deployment variables must exist before any convex/ module is imported.
const { privateKey: deploymentPrivateKey } = installAuthTestEnv();

const modules = {
  "../convex/_generated/api.ts": () => import("../convex/_generated/api.js"),
  "../convex/agentSessions.ts": () => import("../convex/agentSessions.js"),
  "../convex/auth.ts": () => import("../convex/auth.js"),
  "../convex/embeddings.ts": () => import("../convex/embeddings.js"),
  "../convex/files.ts": () => import("../convex/files.js"),
  "../convex/http.ts": () => import("../convex/http.js"),
  "../convex/projects.ts": () => import("../convex/projects.js"),
  "../convex/redirects.ts": () => import("../convex/redirects.js"),
  "../convex/retrieval.ts": () => import("../convex/retrieval.js"),
  "../convex/stt.ts": () => import("../convex/stt.js"),
  "../convex/translation.ts": () => import("../convex/translation.js"),
  "../convex/tts.ts": () => import("../convex/tts.js"),
  "../convex/tutor.ts": () => import("../convex/tutor.js"),
};

const makeTest = () => convexTest({ schema, modules });
// Every helper works with the bound accessor shape that `withIdentity`
// returns; `makeTest()` is assignable to it because it only adds
// `registerComponent`, which no test here uses.
type TestInstance = ReturnType<ReturnType<typeof makeTest>["withIdentity"]>;
const newTest = (): TestInstance => makeTest();

const b64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

/** Signs an access token the way Convex Auth does: RS256 over `{ header }.{ payload }`. */
function signAccessToken(privateKeyPem: string, payload: Record<string, unknown>): string {
  const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem, "base64url");
  return `${signingInput}.${signature}`;
}

// Synthetic second key pair: never a deployment key, never committed material.
const foreignPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as unknown as string;

const claims = (subject: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const now = Math.floor(Date.now() / 1000);
  return { sub: subject, iss: TEST_ISSUER, aud: "convex", iat: now - 60, exp: now + 3600, ...overrides };
};

type Verification = { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Offline mirror of what the Convex runtime does with a presented access token
 * before `ctx.auth` ever resolves: parse the compact JWS, verify the RS256
 * signature against the deployment's published JWKS, then check the issuer,
 * audience and expiry bound by `convex/auth.config.ts`. Nothing here reaches
 * the network: the JWKS comes from the local `convex-test` instance.
 */
async function verifyAccessToken(t: TestInstance, token: string | null): Promise<Verification> {
  if (token === null || token.length === 0) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [encodedHeader, encodedPayload, signature] = parts;
  let header: { alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader as string, "base64url").toString("utf8")) as { alg?: string };
    payload = JSON.parse(Buffer.from(encodedPayload as string, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: "malformed" };

  const jwks = (await (await t.fetch("/.well-known/jwks.json")).json()) as { keys: JsonWebKey[] };
  const jwk = jwks.keys.find((key) => key.alg === "RS256" && key.kty === "RSA");
  if (jwk === undefined) return { ok: false, reason: "malformed" };

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  let signatureValid = false;
  try {
    signatureValid = verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), signature as string, "base64url");
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, reason: "forged" };

  if (payload.iss !== TEST_ISSUER || payload.aud !== "convex") return { ok: false, reason: "forged" };
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

type Presented = { token: string | null; verdict: Verification };

/**
 * Presents a token the way the Convex runtime presents it to a function: a
 * token that fails verification arrives as no identity at all, and a token
 * that verifies arrives as the identity it decodes to. Every assertion below
 * therefore exercises the real denial path of the function under test instead
 * of a blanket "everything throws".
 */
async function present(t: TestInstance, token: string | null): Promise<Presented> {
  return { token, verdict: await verifyAccessToken(t, token) };
}

async function withPresentedToken(t: TestInstance, presented: Presented): Promise<TestInstance> {
  if (!presented.verdict.ok) return t;
  const { sub, iss } = presented.verdict.payload as { sub: string; iss: string };
  return t.withIdentity({ subject: sub, issuer: iss });
}

async function signUp(t: TestInstance): Promise<string> {
  const result = await t.action(api.auth.signIn, { provider: "password", params: { flow: "signUp", email: EMAIL, password: PASSWORD } });
  if (result.tokens === null || result.tokens === undefined) throw new Error("expected tokens");
  return result.tokens.token;
}

const subjectOf = (token: string): string => (JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString("utf8")) as { sub: string }).sub;

test("forged, expired and malformed access tokens fail the deployment's own verification while a real one passes", async () => {
  const t = newTest();
  const real = await signUp(t);
  const subject = subjectOf(real);
  const now = Math.floor(Date.now() / 1000);

  const materials: { name: string; token: string | null; reason: string }[] = [
    { name: "missing", token: null, reason: "missing" },
    { name: "malformed: not a JWS", token: "not-a-jwt", reason: "malformed" },
    { name: "malformed: truncated", token: `${real.split(".")[0]}.${real.split(".")[1]}`, reason: "malformed" },
    { name: "malformed: alg none", token: `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(claims(subject)))}.`, reason: "malformed" },
    { name: "forged: signed by an untrusted key", token: signAccessToken(foreignPrivateKey, claims(subject)), reason: "forged" },
    { name: "forged: wrong issuer", token: signAccessToken(deploymentPrivateKey, claims(subject, { iss: "https://attacker.example.test" })), reason: "forged" },
    { name: "expired", token: signAccessToken(deploymentPrivateKey, claims(subject, { iat: now - 7200, exp: now - 3600 })), reason: "expired" },
  ];

  for (const material of materials) {
    const verdict = await verifyAccessToken(t, material.token);
    expect(verdict.ok, `${material.name} must not verify`).toBe(false);
    if (!verdict.ok) expect(verdict.reason, material.name).toBe(material.reason);
  }

  // Positive control: the real sign-in token verifies through the same code path.
  expect(await verifyAccessToken(t, real)).toMatchObject({ ok: true });
});

test("the ctx.auth identity helper denies an unverified caller with a typed code", async () => {
  const { requireUserId } = await import("../convex/projects.js");
  await expectTypedCode(requireUserId({ auth: { getUserIdentity: async () => null } }), "UNAUTHENTICATED");
});

test("public ctx.auth functions deny missing, forged, malformed and expired tokens with a typed code and accept a verified one", async () => {
  const t = newTest();
  const real = await signUp(t);
  const subject = subjectOf(real);
  const ownerId = subject.split("|")[0] as string;
  const now = Math.floor(Date.now() / 1000);

  const projectId = await t.run(async (ctx) => ctx.db.insert("projects", { ownerId, name: "P", createdAt: 1, deletedAt: null }));
  const sessionId = await t.run(async (ctx) => ctx.db.insert("learningSessions", { ownerId, projectId, sessionKey: "s", createdAt: 1, endedAt: null }));
  const storageId = (await t.run(async (ctx) => ctx.storage.store(new Blob(["fixture"])))) as never;
  const fileId = await t.run(async (ctx) => ctx.db.insert("privateFiles", { ownerId, projectId, storageId, contentType: "text/plain", createdAt: 1 }));

  const calls: { name: string; run: (instance: TestInstance) => Promise<unknown> }[] = [
    { name: "projects.listProjects", run: (instance) => instance.query(api.projects.listProjects, {}) },
    { name: "projects.getProject", run: (instance) => instance.query(api.projects.getProject, { projectId }) },
    { name: "sessions.createSession", run: (instance) => instance.mutation(api.projects.createSession, { projectId, sessionKey: "neg" }) },
    { name: "sessions.createMessage", run: (instance) => instance.mutation(api.projects.createMessage, { projectId, sessionId, turnId: "neg", idempotencyKey: "neg", role: "learner", content: "x" }) },
    { name: "files.getPrivateFile", run: (instance) => instance.query(api.files.getPrivateFile, { projectId, fileId }) },
    { name: "files.registerPrivateFile", run: (instance) => instance.mutation(api.files.registerPrivateFile, { projectId, storageId, contentType: "text/plain" }) },
    { name: "tutor.getTurn", run: (instance) => instance.query(api.tutor.getTurn, { projectId, turnId: "neg" }) },
    { name: "tutor.getTranscript", run: (instance) => instance.query(api.tutor.getTranscript, { projectId }) },
    { name: "tutor.cancelTurn", run: (instance) => instance.mutation(api.tutor.cancelTurn, { projectId, turnId: "neg" }) },
    { name: "tutor.runTurn", run: (instance) => instance.action(api.tutor.runTurn, { projectId, turnId: "neg", text: "hello" }) },
    { name: "retrieval.retrieveProjectContext", run: (instance) => instance.action(api.retrieval.retrieveProjectContext, { projectId, query: "hola", vector: [0, 0, 0, 0] }) },
    { name: "tts.speechOptions", run: (instance) => instance.query(api.tts.speechOptions, {}) },
    { name: "agentSessions.issueConnectionToken", run: (instance) => instance.mutation(api.agentSessions.issueConnectionToken, { projectId }) },
  ];

  const negativeMaterials: { name: string; token: string | null }[] = [
    { name: "missing", token: null },
    { name: "malformed", token: "not-a-jwt" },
    { name: "forged", token: signAccessToken(foreignPrivateKey, claims(subject)) },
    { name: "expired", token: signAccessToken(deploymentPrivateKey, claims(subject, { iat: now - 7200, exp: now - 3600 })) },
  ];

  for (const material of negativeMaterials) {
    const presented = await present(t, material.token);
    expect(presented.verdict.ok, `${material.name} token must not verify`).toBe(false);
    const instance = await withPresentedToken(t, presented);
    for (const call of calls) await expectTypedCode(call.run(instance), "UNAUTHENTICATED");
  }

  // Positive control: the very same calls succeed once the token verifies, so
  // the matrix above is an identity denial and not a broken fixture.
  const verified = await withPresentedToken(t, await present(t, real));
  await expect(verified.query(api.projects.listProjects, {})).resolves.toMatchObject([{ name: "P" }]);
  await expect(verified.query(api.tts.speechOptions, {})).resolves.toMatchObject({ model: expect.any(String) });
  await expect(verified.mutation(api.agentSessions.issueConnectionToken, { projectId })).resolves.toMatchObject({ token: expect.any(String) });
});

test("every authenticated HTTP route answers a rejected token with 401 UNAUTHENTICATED and never echoes the token", async () => {
  const t = newTest();
  const real = await signUp(t);
  const subject = subjectOf(real);
  const ownerId = subject.split("|")[0] as string;
  const now = Math.floor(Date.now() / 1000);

  const projectId = await t.run(async (ctx) => ctx.db.insert("projects", { ownerId, name: "P", createdAt: 1, deletedAt: null }));
  const storageId = (await t.run(async (ctx) => ctx.storage.store(new Blob(["fixture"])))) as never;
  const fileId = await t.run(async (ctx) => ctx.db.insert("privateFiles", { ownerId, projectId, storageId, contentType: "text/plain", createdAt: 1 }));

  const forgedToken = signAccessToken(foreignPrivateKey, claims(subject));
  const expiredToken = signAccessToken(deploymentPrivateKey, claims(subject, { iat: now - 7200, exp: now - 3600 }));

  const materials: { name: string; header: Record<string, string>; token: string | null }[] = [
    { name: "missing Authorization header", header: {}, token: null },
    { name: "malformed Bearer token", header: { authorization: "Bearer not-a-jwt" }, token: "not-a-jwt" },
    { name: "forged Bearer token", header: { authorization: `Bearer ${forgedToken}` }, token: forgedToken },
    { name: "expired Bearer token", header: { authorization: `Bearer ${expiredToken}` }, token: expiredToken },
    { name: "wrong authentication scheme", header: { authorization: "Basic bGVhcm5lcjpwYXNz" }, token: null },
  ];

  const routes: { name: string; send: (instance: TestInstance, headers: Record<string, string>) => Promise<Response> }[] = [
    { name: "POST /stt/transcribe", send: (instance, headers) => instance.fetch(`/stt/transcribe?projectId=${projectId}&language=en&turnId=neg`, { method: "POST", headers: { ...headers, "content-type": "audio/webm" }, body: new Uint8Array([1, 2, 3, 4]) }) },
    { name: "POST /tts/synthesize", send: (instance, headers) => instance.fetch(`/tts/synthesize?projectId=${projectId}&turnId=neg`, { method: "POST", headers }) },
    { name: "POST /translation/text", send: (instance, headers) => instance.fetch(`/translation/text?projectId=${projectId}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ text: "hola", target: "en" }) }) },
    { name: "GET /private-files", send: (instance, headers) => instance.fetch(`/private-files/${fileId}`, { headers }) },
    { name: "POST /private-uploads", send: (instance, headers) => instance.fetch(`/private-uploads?projectId=${projectId}&filename=neg.txt&idempotencyKey=neg`, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "fixture" }) },
  ];

  for (const material of materials) {
    const presented = await present(t, material.token);
    const instance = await withPresentedToken(t, presented);
    for (const route of routes) {
      const response = await route.send(instance, material.header);
      expect(response.status, `${route.name} with ${material.name}`).toBe(401);
      const body = (await response.json()) as { code?: string };
      expect(body.code, `${route.name} with ${material.name}`).toBe("UNAUTHENTICATED");
      if (material.token !== null) expect(JSON.stringify(body)).not.toContain(material.token);
    }
  }

  // Positive control: with a verified token the same route gets past identity.
  const verified = await withPresentedToken(t, await present(t, real));
  const authorized = await verified.fetch(`/tts/synthesize?projectId=${projectId}&turnId=neg`, { method: "POST" });
  expect(authorized.status).not.toBe(401);
});
