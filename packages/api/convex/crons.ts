import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * S09 runner schedule. One bounded cycle every five minutes keeps the job
 * queue moving without approaching Convex Free's 1 million function calls per
 * month (a single internal call per interval plus per-job stage calls), and
 * retry backoff below is sized to be picked up by the following cycles.
 * Empty-queue cycles are cheap: the claim returns null after one bounded scan.
 */
crons.interval("ingestion-cycle", { minutes: 5 }, internal.ingestion.runIngestionCycle, {});

/**
 * S24 log retention: one bounded cleanup batch per hour deletes telemetry
 * rows older than `LOG_RETENTION_DAYS`, so the table rotates instead of
 * growing without limit. The batch is capped (100 rows), so an oversized
 * backlog drains across hourly runs instead of one unbounded mutation.
 */
crons.interval("telemetry-retention", { hours: 1 }, internal.observability.cleanupTelemetry, {});

export default crons;
