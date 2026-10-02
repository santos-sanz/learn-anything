// Hand-maintained binding types for the S07 agent runtime (see
// docs/cloudflare-agent-runtime.md). Mirrors what
// `npx wrangler types --include-runtime false` emits for wrangler.json, plus
// the two secrets that are provisioned with `wrangler secret put` and are
// therefore intentionally absent from the committed configuration.

declare namespace Cloudflare {
  /** Lets `cloudflare:workers`' `exports` and namespace types see this Worker. */
  interface GlobalProps {
    mainModule: typeof import("./src/index.js");
    durableNamespaces: "LearnerAgent";
  }

  interface Env {
    /** Convex deployment HTTP base URL (non-secret deployment coordinate). */
    CONVEX_URL: string;
    /** Owner id of the single-user deployer whose NaN key may be used. */
    NAN_DEPLOYER_ID: string;
    /** Server-side HMAC secret; provisioned per deployment, never committed. */
    AGENT_BRIDGE_SECRET: string;
    /** Server-side NaN API key; provisioned per deployment, never committed. */
    NAN_API_KEY: string;
    /** SQLite-backed Durable Object namespace for learner agents. */
    LearnerAgent: DurableObjectNamespace<import("./src/index.js").LearnerAgent>;
  }
}
