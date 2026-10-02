/** Runtime-neutral marker for contracts added by later stories. */
export const contractVersion = "0" as const;

/** Provider configuration contract for S11. This contains no credential value. */
export const nanProviderConfigVersion = "1" as const;

export type NanCapability =
  | "tutor-chat"
  | "text-translation"
  | "chat-streaming"
  | "embeddings"
  | "rerank"
  | "transcription"
  | "audio-translation-en"
  | "speech";

export interface NanProviderPolicy {
  readonly initialDeployment: "single-user-self-hosted";
  readonly personalNonTransferableKey: true;
  readonly hostedMultiuserStatus: "blocked-pending-provider-agreement";
  readonly byokResolvesCustody: false;
}

export const nanProviderPolicy: NanProviderPolicy = {
  initialDeployment: "single-user-self-hosted",
  personalNonTransferableKey: true,
  hostedMultiuserStatus: "blocked-pending-provider-agreement",
  byokResolvesCustody: false,
};

export const nanOfficialDocumentation = {
  checkedOn: "2026-10-02",
  apiExamples: "https://nan.builders/docs/examples",
  models: "https://nan.builders/docs/models",
  terms: "https://nan.builders/terms",
} as const;
