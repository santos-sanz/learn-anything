export const NAN_BASE_URL = "https://api.nan.builders/v1" as const;

export const nanModels = {
  chat: "deepseek-v4-flash",
  embedding: "qwen3-embedding",
  rerank: "rerank",
  whisper: "whisper",
  speech: "kokoro",
} as const;

export const nanVoices = {
  english: "af_heart",
  spanish: "ef_dora",
} as const;

export type NanChatModel = typeof nanModels.chat;
export type NanEmbeddingModel = typeof nanModels.embedding;
export type NanRerankModel = typeof nanModels.rerank;
export type NanWhisperModel = typeof nanModels.whisper;
export type NanSpeechModel = typeof nanModels.speech;
export type NanVoice = (typeof nanVoices)[keyof typeof nanVoices];
export type NanLanguage = "en" | "es";

export interface NanQuotaControls {
  readonly timeoutMs: number;
  readonly maxRetries: 0;
  readonly maxInputCharacters: number;
  readonly maxOutputTokens: number;
  readonly maxAudioBytes: number;
}

export const defaultNanQuotaControls: NanQuotaControls = {
  timeoutMs: 15_000,
  maxRetries: 0,
  maxInputCharacters: 24_000,
  maxOutputTokens: 500,
  maxAudioBytes: 25 * 1024 * 1024,
};

export type NanMessage = { role: "system" | "user" | "assistant"; content: string };
export type NanAudioInput = { bytes: Uint8Array; filename: string; mimeType: string };

export class NanAdapterError extends Error {
  public constructor(
    public readonly code:
      | "NAN_TIMEOUT"
      | "NAN_CANCELLED"
      | "NAN_RATE_LIMITED"
      | "NAN_UNSUPPORTED_MODEL"
      | "NAN_UNSUPPORTED_CAPABILITY"
      | "NAN_MALFORMED_RESPONSE"
      | "NAN_PROVIDER_ERROR"
      | "NAN_POLICY_BLOCKED"
      | "NAN_INPUT_TOO_LARGE",
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "NanAdapterError";
  }
}

export interface NanFetchOptions { signal?: AbortSignal }
export type NanFetch = (input: string, init?: RequestInit) => Promise<Response>;
