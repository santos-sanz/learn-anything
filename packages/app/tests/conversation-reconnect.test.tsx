// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { convexTest } from "convex-test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { api, internal } from "../../api/convex/_generated/api.js";
import schema from "../../api/convex/schema.js";
import { installAuthTestEnv, TEST_ISSUER } from "../../api/tests/helpers/authEnv.js";
import { SpokenConversation } from "../src/SpokenConversation.js";
import { QUESTION, convexVoicePorts, installVoiceProviderMock } from "./helpers/voiceConversation.js";
import { ensureSubtleCrypto } from "./jsdomCrypto.js";

/**
 * S17 reconnect test: a real turn (real upload → real ingestion → real S14
 * commit with citations) renders in the server-backed history, then a fresh
 * mount — the page/app reconnect — restores the same transcripts and citation
 * links from the authorized server reads, and they stay visible while a new
 * listening cycle runs. Nothing survives only in the browser.
 */

// Must run before any convex/ module is imported (JWT material is synthetic).
installAuthTestEnv();
// convex-test's storage hashing needs WebCrypto even where jsdom shadows it.
ensureSubtleCrypto();

const modules = {
  "../../api/convex/_generated/api.ts": () => import("../../api/convex/_generated/api.js"),
  "../../api/convex/agentSessions.ts": () => import("../../api/convex/agentSessions.js"),
  "../../api/convex/auth.ts": () => import("../../api/convex/auth.js"),
  "../../api/convex/documents.ts": () => import("../../api/convex/documents.js"),
  "../../api/convex/embeddings.ts": () => import("../../api/convex/embeddings.js"),
  "../../api/convex/files.ts": () => import("../../api/convex/files.js"),
  "../../api/convex/http.ts": () => import("../../api/convex/http.js"),
  "../../api/convex/ingestion.ts": () => import("../../api/convex/ingestion.js"),
  "../../api/convex/languagePractice.ts": () => import("../../api/convex/languagePractice.js"),
  "../../api/convex/projects.ts": () => import("../../api/convex/projects.js"),
  "../../api/convex/redirects.ts": () => import("../../api/convex/redirects.js"),
  "../../api/convex/retrieval.ts": () => import("../../api/convex/retrieval.js"),
  "../../api/convex/sources.ts": () => import("../../api/convex/sources.js"),
  "../../api/convex/stt.ts": () => import("../../api/convex/stt.js"),
  "../../api/convex/translation.ts": () => import("../../api/convex/translation.js"),
  "../../api/convex/tutor.ts": () => import("../../api/convex/tutor.js"),
  "../../api/convex/tts.ts": () => import("../../api/convex/tts.js"),
};

const identity = (subject: string) => ({ subject, issuer: TEST_ISSUER });
const fixture = (name: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(join(process.cwd(), "packages/api/tests/fixtures", name)));

let provider: ReturnType<typeof installVoiceProviderMock>;

beforeEach(() => {
  process.env.NAN_API_KEY = "synthetic-test-key";
  process.env.NAN_DEPLOYER_ID = "learner-a";
  process.env.TUTOR_RETRY_BASE_MS = "0";
  provider = installVoiceProviderMock();
  window.location.hash = "";
});

afterEach(() => {
  provider.restore();
  delete process.env.NAN_API_KEY;
  delete process.env.NAN_DEPLOYER_ID;
  delete process.env.TUTOR_RETRY_BASE_MS;
  cleanup();
});

const STAGE_LABELS: Record<string, string> = {
  listening: "Listening",
  transcribing: "Transcribing",
  generating: "Retrieving & generating",
  speaking: "Speaking",
  ready: "Ready",
};

function stageResult(stage: string): string | null {
  return screen.getByText(STAGE_LABELS[stage]).closest("li")?.querySelector(".stage-result")?.textContent ?? null;
}

function historyRegion() {
  return within(screen.getByRole("region", { name: "Conversation history" }));
}

test("transcripts and citations survive a reconnect and stay visible while listening", async () => {
  const t = convexTest({ schema, modules });
  const a = t.withIdentity(identity("learner-a"));
  const projectId = await a.mutation(api.projects.createProject, { name: "Reconnect project" });

  // Real S08 upload → real S09 ingestion (offline embeddings) → ready chunks.
  const upload = await a.fetch(`/private-uploads?projectId=${projectId}&filename=three-page-lesson.pdf&idempotencyKey=reconnect-1`, {
    method: "POST",
    headers: { "content-type": "application/pdf" },
    body: fixture("three-page-lesson.pdf"),
  });
  expect(upload.status).toBe(201);
  const cycle = await t.action(internal.ingestion.runIngestionCycle, { workerId: "worker-a" });
  expect(cycle.outcomes[0]?.outcome).toBe("succeeded");
  const chunk = await t.run(async (ctx) => {
    const rows = await ctx.db.query("documentChunks").collect();
    return rows.sort((left, right) => left.seq - right.seq)[0];
  });
  expect(chunk).toBeDefined();

  const ports = convexVoicePorts(a);
  render(<SpokenConversation projectId={projectId} conversation={ports.backend} capture={ports.capture} playback={ports.playback} />);
  const user = userEvent.setup();

  // One grounded turn: record → transcribe → generate → speak → ready.
  await user.click(await screen.findByRole("radio", { name: /Transcribe speech/ }));
  await user.click(screen.getByRole("button", { name: "Record a turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 5_000 });
  await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
  await waitFor(() => expect(stageResult("speaking")).toBe("in progress"), { timeout: 10_000 });
  await waitFor(() => expect(ports.playbacks).toHaveLength(1), { timeout: 5_000 });
  ports.playbacks[0].ended();
  await waitFor(() => expect(stageResult("ready")).toBe("reached"), { timeout: 5_000 });

  // The committed transcript carries a citation into the history panel.
  await waitFor(() => expect(historyRegion().getByText(QUESTION)).toBeTruthy(), { timeout: 5_000 });
  const citation = historyRegion().getByRole("link");
  expect(citation.getAttribute("href")).toContain(chunk._id);

  // RECONNECT: a fresh mount (same server, new client) restores everything.
  cleanup();
  render(<SpokenConversation projectId={projectId} conversation={ports.backend} capture={ports.capture} playback={ports.playback} />);
  await waitFor(() => expect(historyRegion().getByText(QUESTION)).toBeTruthy(), { timeout: 5_000 });
  expect(historyRegion().getByText((content) => content.includes("Plants turn light into chemical energy"))).toBeTruthy();
  const restoredCitation = historyRegion().getByRole("link");
  expect(restoredCitation.getAttribute("href")).toContain(chunk._id);
  // The restored answer is playable: the player comes back with the transcript.
  await waitFor(() => expect(document.querySelector(".response-player")?.textContent ?? "").toContain("Plants turn light into chemical energy"), { timeout: 5_000 });

  // While a new listening cycle runs, nothing from the history disappears.
  await user.click(await screen.findByRole("radio", { name: /Transcribe speech/ }));
  await user.click(screen.getByRole("button", { name: "Record a turn" }));
  await waitFor(() => expect(stageResult("listening")).toBe("in progress"), { timeout: 5_000 });
  expect(historyRegion().getByText(QUESTION)).toBeTruthy();
  expect(historyRegion().getByRole("link").getAttribute("href")).toContain(chunk._id);

  // Server truth behind the panel: one turn, learner + tutor + one citation.
  const messages = await t.run(async (ctx) => ctx.db.query("messages").collect());
  const citations = await t.run(async (ctx) => ctx.db.query("citations").collect());
  expect(messages).toHaveLength(2);
  expect(citations).toHaveLength(1);
  expect(provider.counts.chat).toBe(1);
}, 60_000);
