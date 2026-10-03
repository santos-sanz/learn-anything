import {
  MAX_SPEECH_TEXT_CHARS,
  NanClient,
  resolveSpeechVoice,
  speechCatalog,
  speechTextFromTutorAnswer,
} from "../../worker/src/nan/index";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { httpAction, internalQuery, query } from "./_generated/server";
import { corsHeaders, readCorsAllowlist } from "./cors";
import { requireOwnedProject, requireUserId } from "./projects";
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  MAX_TURN_ID_CHARS,
  classifyAuthorizeFailure,
  mapProviderFailure,
  type ProviderFailureScope,
} from "./stt";

/**
 * S16 authenticated Kokoro TTS delivery. `POST /tts/synthesize?projectId=&`
 * `turnId=&language=&voice=` answers with the synthesized MP3 bytes of one
 * stored tutor response. The design keeps every S16 security property in the
 * request itself:
 *
 * - **Access is re-checked on every request**: identity comes only from
 *   `ctx.auth`, then an internal query re-checks project ownership and loads
 *   the stored tutor message for that exact `(owner, project, turn)` triple.
 *   A foreign project, a foreign turn and an unknown turn are the same
 *   non-enumerating `404`, so audio bytes exist only for rows the caller owns.
 * - **No bearer links, no stored audio**: the route never calls
 *   `storage.getUrl`, never writes bytes to Convex storage or a table, and
 *   answers `Cache-Control: private, no-store`. Bytes live inside one request
 *   (response body) and are never committed or logged.
 * - **Voice/language come from provider configuration**: an unsupported voice
 *   or language is a typed `422` listing what is configured — never a silent
 *   fallback to another voice, and never a claim that every STT language has
 *   a TTS voice.
 * - **Stale audio is rejected**: a turn row that is not `completed`
 *   (`running`, `cancelled`, `failed`) has no synthesizable response, so a
 *   response arriving after a cancellation cannot be turned into audio here.
 */
export const ttsFailureScope: ProviderFailureScope = { prefix: "TTS", inputTooLargeCode: "TEXT_TOO_LARGE" };

const languageValidator = v.union(v.literal("en"), v.literal("es"));

/** The configured voice/language/limit contract for the player's pickers. */
export const speechOptions = query({
  args: {},
  returns: v.object({
    model: v.string(),
    format: v.literal("mp3"),
    languages: v.array(languageValidator),
    voices: v.array(v.object({ id: v.string(), language: languageValidator, label: v.string() })),
    maxTextChars: v.number(),
  }),
  handler: async (ctx) => {
    await requireUserId(ctx);
    const catalog = speechCatalog();
    return {
      model: catalog.model,
      format: catalog.format,
      languages: [...catalog.languages],
      voices: catalog.voices.map((voice) => ({ id: voice.id, language: voice.language, label: voice.label })),
      maxTextChars: catalog.maxTextChars,
    };
  },
});

/**
 * Ownership gate for one synthesis request: the caller must own the project,
 * the turn row must exist and be `completed`, and the stored tutor message for
 * that turn must still be present. Everything else — foreign project, unknown
 * turn, a running/cancelled/failed turn, or a turn with no committed tutor
 * message — is the same non-enumerating `NOT_FOUND`, so a caller can neither
 * probe other tenants nor request audio for a turn whose response was
 * cancelled away.
 */
export const resolveSpeechTarget = internalQuery({
  args: { ownerId: v.string(), projectId: v.id("projects"), turnId: v.string() },
  returns: v.object({ text: v.string() }),
  handler: async (ctx, args): Promise<{ text: string }> => {
    await requireOwnedProject(ctx, args.ownerId, args.projectId);
    const turn = await ctx.db
      .query("tutorTurns")
      .withIndex("by_owner_project_turn", (q) =>
        q.eq("ownerId", args.ownerId).eq("projectId", args.projectId).eq("turnId", args.turnId),
      )
      .unique();
    if (turn === null || turn.status !== "completed") throw new ConvexError({ code: "NOT_FOUND" });
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_owner_project_turn", (q) =>
        q.eq("ownerId", args.ownerId).eq("projectId", args.projectId).eq("turnId", args.turnId),
      )
      .collect();
    const tutorMessage = messages.find((message) => message.role === "tutor");
    if (tutorMessage === undefined) throw new ConvexError({ code: "NOT_FOUND" });
    return { text: tutorMessage.content };
  },
});

function configuredTtsTimeoutMs(): number {
  const raw = Number(process.env.TTS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROVIDER_TIMEOUT_MS;
}

function failureBody(failure: ReturnType<typeof mapProviderFailure>): Record<string, unknown> {
  const body: Record<string, unknown> = { code: failure.code };
  if (failure.retryAfterMs !== undefined) body.retryAfterMs = failure.retryAfterMs;
  if (failure.upstreamStatus !== undefined) body.upstreamStatus = failure.upstreamStatus;
  return body;
}

/**
 * POST /tts/synthesize?projectId=&turnId=&language=&voice= — no request body:
 * the spoken text is only ever the stored tutor message the internal query
 * returns, so the caller cannot synthesize arbitrary text through this route.
 * The page origin is cross-origin to `.convex.site`, so the `OPTIONS`
 * preflight (see `http.ts`) is answered first and every response — bytes or
 * typed error — carries the CORS headers from `cors.ts`.
 */
export const synthesizeSpeechRoute = httpAction(async (ctx, request) => {
  const cors = corsHeaders(request.headers.get("Origin"), readCorsAllowlist());
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "content-type": "application/json", "cache-control": "private, no-store" },
    });

  let ownerId: string;
  try {
    ownerId = await requireUserId(ctx);
  } catch {
    return json({ code: "UNAUTHENTICATED" }, 401);
  }

  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const turnId = url.searchParams.get("turnId") ?? "";
  const requestedLanguage = url.searchParams.get("language");
  const requestedVoice = url.searchParams.get("voice");
  if (projectId === "" || turnId === "" || turnId.length > MAX_TURN_ID_CHARS) {
    return json({ code: "INVALID_ARGUMENT" }, 400);
  }

  // Identity and ownership are re-derived here on every request, before any
  // provider configuration detail or byte is revealed.
  let target: { text: string };
  try {
    target = await ctx.runQuery(internal.tts.resolveSpeechTarget, {
      ownerId,
      projectId: projectId as never,
      turnId,
    });
  } catch (error) {
    const failure = classifyAuthorizeFailure(error);
    return json({ code: failure.code }, failure.status);
  }

  const voice = resolveSpeechVoice({ language: requestedLanguage, voice: requestedVoice });
  if (!voice.ok) {
    return json({ code: voice.code, supportedVoices: voice.supportedVoices, supportedLanguages: voice.supportedLanguages }, 422);
  }

  const text = speechTextFromTutorAnswer(target.text);
  if (text === "") return json({ code: "INVALID_ARGUMENT" }, 400);
  if (text.length > MAX_SPEECH_TEXT_CHARS) {
    return json({ code: "TEXT_TOO_LARGE", maxChars: MAX_SPEECH_TEXT_CHARS }, 413);
  }

  const apiKey = (process.env.NAN_API_KEY ?? "").trim();
  if (apiKey === "") return json({ code: "TTS_NOT_CONFIGURED" }, 503);
  const deployerId = (process.env.NAN_DEPLOYER_ID ?? "").trim();

  const client = new NanClient({
    apiKey,
    deployment: { mode: "single-user-self-hosted", learnerId: ownerId, deployerId: deployerId === "" ? undefined : deployerId },
    quotaControls: { timeoutMs: configuredTtsTimeoutMs() },
  });

  try {
    const audio = await client.speech(text, voice.voice, { signal: request.signal });
    // Raw bytes as the body: a jsdom Blob (any browser-like test runtime)
    // cannot be consumed by the host Response implementation, while the
    // Uint8Array body behaves identically in production and in tests.
    return new Response(audio.slice(), {
      status: 200,
      headers: {
        ...cors,
        "content-type": "audio/mpeg",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const failure = mapProviderFailure(error, ttsFailureScope);
    return json(failureBody(failure), failure.status);
  }
});
