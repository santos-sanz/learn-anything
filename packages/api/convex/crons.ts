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

export default crons;
