/** Ingestion-runner entry point; parser stages live under ./ingestion. */
export const workerEntryPoint = "ingestion-runner" as const;

export * from "./ingestion/index.js";
export * from "./nan/index.js";
