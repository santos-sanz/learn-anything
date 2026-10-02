import { assertNanProviderPolicy, type NanDeploymentContext } from "./policy.js";
import {
  defaultNanQuotaControls,
  NAN_BASE_URL,
  nanModels,
  nanVoices,
  NanAdapterError,
  type NanAudioInput,
  type NanFetch,
  type NanFetchOptions,
  type NanLanguage,
  type NanMessage,
  type NanQuotaControls,
  type NanVoice,
} from "./types.js";

type NanCapability =
  | "tutor-chat" | "text-translation" | "chat-streaming" | "embeddings"
  | "rerank" | "transcription" | "audio-translation-en" | "speech";

export interface NanClientOptions {
  /** Server-only secret. Never serialize this object into client configuration. */
  apiKey: string;
  fetch?: NanFetch;
  quotaControls?: Partial<NanQuotaControls>;
  deployment: NanDeploymentContext;
}

type ChatResponse = { choices: Array<{ message: { content: string } }> };

export class NanClient {
  readonly baseUrl = NAN_BASE_URL;
  readonly quota: NanQuotaControls;
  private readonly fetchImplementation: NanFetch;

  public constructor(private readonly options: NanClientOptions) {
    if (!options.apiKey) throw new NanAdapterError("NAN_PROVIDER_ERROR", "NAN_API_KEY is required on the server.");
    this.fetchImplementation = options.fetch ?? fetch;
    this.quota = { ...defaultNanQuotaControls, ...options.quotaControls, maxRetries: 0 };
  }

  async tutor(messages: NanMessage[], options: NanFetchOptions = {}): Promise<string> {
    return this.chat("tutor-chat", messages, options);
  }

  async translateText(text: string, source: NanLanguage, target: NanLanguage, options: NanFetchOptions = {}): Promise<string> {
    if (source === target) return text;
    return this.chat("text-translation", [{ role: "system", content: `Translate from ${source} to ${target}. Return only the translation.` }, { role: "user", content: text }], options);
  }

  async *streamTutor(messages: NanMessage[], options: NanFetchOptions = {}): AsyncGenerator<string> {
    this.assertInput(messages.map((message) => message.content).join(""));
    const response = await this.request("chat-streaming", "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: nanModels.chat, messages, max_tokens: this.quota.maxOutputTokens, stream: true }),
    }, options);
    if (!response.body) throw new NanAdapterError("NAN_MALFORMED_RESPONSE", "NaN streaming response has no body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const data = line.trim().replace(/^data:\s*/, "");
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            const content = parsed.choices?.[0]?.delta?.content;
            if (typeof content === "string") yield content;
            else throw new Error("missing delta content");
          } catch {
            throw new NanAdapterError("NAN_MALFORMED_RESPONSE", "NaN returned an invalid streaming event.");
          }
        }
      }
    } finally { reader.releaseLock(); }
  }

  async embeddings(input: string[], options: NanFetchOptions = {}): Promise<number[][]> {
    this.assertInput(input.join(""));
    const response = await this.json<{ data?: Array<{ embedding?: unknown }> }>("embeddings", "/embeddings", {
      method: "POST", body: JSON.stringify({ model: nanModels.embedding, input, encoding_format: "float" }),
    }, options);
    const embeddings = response.data?.map((item) => item.embedding);
    if (!embeddings || embeddings.length !== input.length || !embeddings.every((vector) => Array.isArray(vector) && vector.length === 4096 && vector.every((value) => typeof value === "number"))) {
      throw new NanAdapterError("NAN_MALFORMED_RESPONSE", "NaN embeddings must contain one 4096-dimensional numeric vector per input.");
    }
    return embeddings as number[][];
  }

  /** /rerank is NaN-specific and deliberately not folded into OpenAI-compatible methods. */
  async rerank(query: string, documents: string[], options: NanFetchOptions = {}): Promise<Array<{ index: number; relevanceScore: number }>> {
    this.assertInput(query + documents.join(""));
    const response = await this.json<{ results?: Array<{ index?: unknown; relevance_score?: unknown }> }>("rerank", "/rerank", {
      method: "POST", body: JSON.stringify({ model: nanModels.rerank, query, documents }),
    }, options);
    if (!Array.isArray(response.results) || !response.results.every((item) => typeof item.index === "number" && typeof item.relevance_score === "number")) {
      throw new NanAdapterError("NAN_MALFORMED_RESPONSE", "NaN rerank response is malformed.");
    }
    return response.results.map((item) => ({ index: item.index as number, relevanceScore: item.relevance_score as number }));
  }

  async transcribe(audio: NanAudioInput, language: NanLanguage, options: NanFetchOptions = {}): Promise<{ text: string; language: NanLanguage; duration?: number }> {
    return this.audioJson("transcription", "/audio/transcriptions", audio, language, options);
  }

  async translateAudioToEnglish(audio: NanAudioInput, options: NanFetchOptions = {}): Promise<{ text: string }> {
    const result = await this.audioJson("audio-translation-en", "/audio/translations", audio, undefined, options);
    return { text: result.text };
  }

  async speech(input: string, voice: NanVoice = nanVoices.english, options: NanFetchOptions = {}): Promise<Uint8Array> {
    this.assertInput(input);
    if (!Object.values(nanVoices).includes(voice)) throw new NanAdapterError("NAN_UNSUPPORTED_CAPABILITY", `Unsupported Kokoro voice: ${voice}`);
    const response = await this.request("speech", "/audio/speech", {
      method: "POST", body: JSON.stringify({ model: nanModels.speech, input, voice, response_format: "mp3", speed: 1 }),
    }, options);
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength === 0) throw new NanAdapterError("NAN_MALFORMED_RESPONSE", "NaN speech response is empty.");
    return audio;
  }

  private async audioJson(capability: NanCapability, path: string, audio: NanAudioInput, language: NanLanguage | undefined, options: NanFetchOptions): Promise<{ text: string; language: NanLanguage; duration?: number }> {
    if (audio.bytes.byteLength > this.quota.maxAudioBytes) throw new NanAdapterError("NAN_INPUT_TOO_LARGE", "Audio exceeds the configured NaN limit.");
    const form = new FormData();
    form.set("model", nanModels.whisper);
    form.set("file", new Blob([new Uint8Array(audio.bytes).buffer], { type: audio.mimeType }), audio.filename);
    if (language) form.set("language", language);
    const response = await this.json<{ text?: unknown; language?: unknown; duration?: unknown }>(capability, path, { method: "POST", body: form }, options);
    if (typeof response.text !== "string" || (response.language !== undefined && response.language !== "en" && response.language !== "es") || (response.duration !== undefined && typeof response.duration !== "number")) {
      throw new NanAdapterError("NAN_MALFORMED_RESPONSE", "NaN Whisper response is malformed.");
    }
    return { text: response.text, language: (response.language ?? language ?? "en") as NanLanguage, duration: response.duration as number | undefined };
  }

  private async chat(capability: NanCapability, messages: NanMessage[], options: NanFetchOptions): Promise<string> {
    this.assertInput(messages.map((message) => message.content).join(""));
    const response = await this.json<ChatResponse>(capability, "/chat/completions", { method: "POST", body: JSON.stringify({ model: nanModels.chat, messages, max_tokens: this.quota.maxOutputTokens }) }, options);
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new NanAdapterError("NAN_MALFORMED_RESPONSE", "NaN chat response is missing content.");
    return content;
  }

  private async json<T>(capability: NanCapability, path: string, init: RequestInit, options: NanFetchOptions): Promise<T> {
    const response = await this.request(capability, path, init, options);
    try { return await response.json() as T; } catch { throw new NanAdapterError("NAN_MALFORMED_RESPONSE", "NaN returned invalid JSON."); }
  }

  private async request(capability: NanCapability, path: string, init: RequestInit, options: NanFetchOptions): Promise<Response> {
    assertNanProviderPolicy(this.options.deployment, capability);
    const timeout = AbortSignal.timeout(this.quota.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await this.fetchWithAbort(`${NAN_BASE_URL}${path}`, { ...init, signal, headers: { Authorization: `Bearer ${this.options.apiKey}`, ...init.headers } }, signal);
      if (response.status === 429) throw new NanAdapterError("NAN_RATE_LIMITED", "NaN rate limit reached.", retryAfterMs(response.headers.get("retry-after")));
      if (response.status === 400 || response.status === 404) throw new NanAdapterError("NAN_UNSUPPORTED_MODEL", `NaN rejected the configured model for ${capability}.`);
      if (!response.ok) throw new NanAdapterError("NAN_PROVIDER_ERROR", `NaN request failed with HTTP ${response.status}.`);
      return response;
    } catch (error) {
      if (error instanceof NanAdapterError) throw error;
      if (options.signal?.aborted) throw new NanAdapterError("NAN_CANCELLED", "NaN request was cancelled.");
      if (timeout.aborted) throw new NanAdapterError("NAN_TIMEOUT", "NaN request timed out.");
      throw new NanAdapterError("NAN_PROVIDER_ERROR", "NaN request failed without a provider response.");
    }
  }

  private assertInput(input: string): void {
    if (input.length > this.quota.maxInputCharacters) throw new NanAdapterError("NAN_INPUT_TOO_LARGE", "Input exceeds the configured NaN limit.");
  }

  private async fetchWithAbort(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return Promise.race([this.fetchImplementation(url, init), aborted]);
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
