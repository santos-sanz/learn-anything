import { NanAdapterError } from "./types.js";

type NanCapability =
  | "tutor-chat" | "text-translation" | "chat-streaming" | "embeddings"
  | "rerank" | "transcription" | "audio-translation-en" | "speech";

/** Mirrors the runtime-neutral shared policy without importing browser-visible configuration. */
export const nanProviderPolicy = {
  initialDeployment: "single-user-self-hosted",
  personalNonTransferableKey: true,
  hostedMultiuserStatus: "blocked-pending-provider-agreement",
  byokResolvesCustody: false,
} as const;

export interface NanDeploymentContext {
  readonly mode: "single-user-self-hosted" | "hosted-multiuser";
  readonly learnerId: string;
  readonly deployerId?: string;
}

/** Blocks personal-key use outside the explicitly approved single-user deployment. */
export function assertNanProviderPolicy(context: NanDeploymentContext, capability: NanCapability): void {
  if (context.mode !== "single-user-self-hosted" || context.learnerId !== context.deployerId) {
    throw new NanAdapterError(
      "NAN_POLICY_BLOCKED",
      `NaN ${capability} is blocked: personal non-transferable keys may only serve the deployer in the initial single-user deployment. BYOK does not resolve hosted credential custody.`,
    );
  }
}
