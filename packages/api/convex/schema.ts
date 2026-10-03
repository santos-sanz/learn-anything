import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * S04 durable learning records. `projects` is the root of a project's scope;
 * every child record repeats both ownerId and projectId so its access path can
 * be tenant-scoped without a scan. S06 adds Convex Auth's `authTables` and the
 * scoped agent connection tokens verified on the agent handshake.
 */
export default defineSchema({
  ...authTables,
  schemaMetadata: defineTable({
    key: v.literal("primary"),
    schemaVersion: v.number(),
    functionVersion: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
  migrationRuns: defineTable({
    migration: v.string(),
    targetSchemaVersion: v.number(),
    status: v.union(v.literal("running"), v.literal("completed")),
    cursor: v.union(v.null(), v.string()),
    attempts: v.number(),
    updatedAt: v.number(),
  }).index("by_migration", ["migration"]),
  /**
   * S21 adds optional `goal` and `mode` for onboarding/goal-mode selection.
   * Both are optional so v3 rows stay valid without a backfill; `mode` uses the
   * two learner-facing tracks only (S19/S20 implement the tutor behaviour).
   */
  projects: defineTable({
    ownerId: v.string(),
    name: v.string(),
    goal: v.optional(v.string()),
    mode: v.optional(v.union(v.literal("language-practice"), v.literal("concept-learning"))),
    createdAt: v.number(),
    deletedAt: v.union(v.null(), v.number()),
  }).index("by_owner", ["ownerId"]),
  learningGoals: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    title: v.string(),
    createdAt: v.number(),
  }).index("by_owner_project", ["ownerId", "projectId"]),
  learningSessions: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    sessionKey: v.string(),
    createdAt: v.number(),
    endedAt: v.union(v.null(), v.number()),
  })
    .index("by_owner_project", ["ownerId", "projectId"])
    .index("by_owner_project_session_key", ["ownerId", "projectId", "sessionKey"]),
  messages: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    sessionId: v.id("learningSessions"),
    turnId: v.string(),
    idempotencyKey: v.string(),
    role: v.union(v.literal("learner"), v.literal("tutor")),
    content: v.string(),
    createdAt: v.number(),
  })
    .index("by_owner_project", ["ownerId", "projectId"])
    .index("by_owner_project_session", ["ownerId", "projectId", "sessionId"])
    .index("by_owner_project_turn", ["ownerId", "projectId", "turnId"])
    .index("by_owner_project_idempotency", ["ownerId", "projectId", "idempotencyKey"]),
  progressEvents: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    eventType: v.string(),
    createdAt: v.number(),
  }).index("by_owner_project", ["ownerId", "projectId"]),
  /**
   * S14 one row per submitted tutor turn, keyed by (ownerId, projectId,
   * turnId). It is the linearization point for idempotency and cancellation:
   * `beginTurn` inserts it before any provider work, a retry with the same
   * `turnId` observes the existing row instead of starting a second attempt,
   * `cancelTurn` flips a `running` row to `cancelled`, and `commitTurn` writes
   * messages/citations only while the row is still `running` under the same
   * `attemptToken`. `retrievedChunkIds` records exactly which chunks scoped
   * retrieval returned for this turn, so a citation written later must be a
   * member of that set. All optional columns are additive: an interrupted row
   * reads as running with an expired lease and is taken over by the next
   * attempt.
   */
  tutorTurns: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    sessionId: v.id("learningSessions"),
    turnId: v.string(),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("cancelled"), v.literal("failed")),
    attempts: v.number(),
    attemptToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    learnerText: v.string(),
    retrievedChunkIds: v.array(v.id("documentChunks")),
    evidence: v.optional(
      v.object({
        status: v.union(v.literal("ok"), v.literal("insufficient-evidence")),
        reason: v.union(v.null(), v.string()),
      }),
    ),
    answerBasis: v.optional(v.union(v.literal("document-backed"), v.literal("general-explanation"))),
    failureCode: v.optional(v.string()),
    providerAttempts: v.optional(v.number()),
    unresolvedMarkers: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    endedAt: v.optional(v.number()),
  })
    .index("by_owner_project", ["ownerId", "projectId"])
    .index("by_owner_project_turn", ["ownerId", "projectId", "turnId"])
    .index("by_owner_project_session", ["ownerId", "projectId", "sessionId"]),
  /**
   * S14 stored citation references attached to a tutor message. The chunk is
   * the citation's identity: `documentId`/`seq`/`contentHash`/`page`/`heading`
   * are copied from the owned chunk row at write time, never from a caller, so
   * a citation can only ever describe a chunk this owner's retrieval actually
   * returned for the turn (`tutorTurns.retrievedChunkIds`). Rendering
   * re-checks every row against the live chunk and document before display.
   */
  citations: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    messageId: v.id("messages"),
    turnId: v.string(),
    rank: v.number(),
    retrievalRank: v.number(),
    documentId: v.id("documents"),
    chunkId: v.id("documentChunks"),
    seq: v.number(),
    contentHash: v.string(),
    page: v.union(v.null(), v.number()),
    heading: v.union(v.null(), v.string()),
  })
    .index("by_owner_project", ["ownerId", "projectId"])
    .index("by_message", ["messageId"])
    .index("by_owner_project_turn", ["ownerId", "projectId", "turnId"]),
  /** Generic private storage ownership. S08 adds document metadata/ingestion separately. */
  privateFiles: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    storageId: v.id("_storage"),
    contentType: v.string(),
    createdAt: v.number(),
  })
    .index("by_owner_project", ["ownerId", "projectId"])
    .index("by_storage_id", ["storageId"]),
  /**
   * S06 agent connection tokens: a hash of a short-lived secret bound to one
   * owner and project. The plaintext exists only in the issue/rotate response.
   */
  agentConnectionTokens: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    tokenHash: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.union(v.null(), v.number()),
    lastVerifiedAt: v.union(v.null(), v.number()),
    verifyCount: v.number(),
    authSessionId: v.optional(v.string()),
    replacedBy: v.optional(v.id("agentConnectionTokens")),
  })
    .index("by_owner", ["ownerId"])
    .index("by_owner_project", ["ownerId", "projectId"])
    .index("by_token_hash", ["tokenHash"]),
  /**
   * S08 document metadata. The `_storage` id is written only after project
   * ownership and content checks passed in the upload HTTP action, and the
   * paired `privateFiles` row is what `/private-files/:fileId` serves. Queries
   * return status metadata only: never bytes and never a bearer storage URL.
   */
  documents: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    privateFileId: v.id("privateFiles"),
    storageId: v.id("_storage"),
    filename: v.string(),
    extension: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
    status: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed")),
    failureCode: v.union(v.null(), v.string()),
    idempotencyKey: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_project", ["ownerId", "projectId"])
    .index("by_owner_project_idempotency", ["ownerId", "projectId", "idempotencyKey"])
    .index("by_storage_id", ["storageId"]),
  /**
   * S08 queues exactly one job per uploaded document; S09 owns leases, retries
   * and execution states. `by_document` is the idempotency guard, so a retried
   * upload never creates a second job for the same document.
   *
   * S09 adds lease/retry fields as optional, additive columns so an S08-era row
   * still validates: `nextAttemptAt`/`maxAttempts` are backfilled by the
   * resumable v6 migration (rows missing `nextAttemptAt` are also claimable
   * through `by_status` until it runs), and an absent lease means idle.
   * `failed` is the dead letter; `unsupported` is the terminal state for
   * encrypted/scanned/unsupported inputs and is never retried.
   */
  ingestionJobs: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    documentId: v.id("documents"),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("unsupported"),
    ),
    attempts: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    maxAttempts: v.optional(v.number()),
    leaseOwner: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    failureCode: v.optional(v.string()),
    contentVersionKey: v.optional(v.string()),
    chunkCount: v.optional(v.number()),
  })
    .index("by_owner_project", ["ownerId", "projectId"])
    .index("by_document", ["documentId"])
    .index("by_status", ["status"])
    .index("by_status_next", ["status", "nextAttemptAt"]),
  /**
   * S09 chunk rows produced by the pluggable process step. The commit is an
   * upsert keyed by (`documentId`, `chunkKey`) where `chunkKey` derives from
   * `contentVersionKey` = `sha256(content):v<contract>`, so replayed jobs keep
   * the same rows instead of appending duplicates. S10's source-aware step
   * fills them with size/overlap windows whose locator names the page (PDF)
   * or nearest heading path (Markdown/text); embedding/vector fields are
   * deliberately absent here because S12 owns the index.
   */
  documentChunks: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    documentId: v.id("documents"),
    contentVersionKey: v.string(),
    seq: v.number(),
    chunkKey: v.string(),
    text: v.string(),
    contentHash: v.string(),
    locator: v.object({
      blockIndex: v.number(),
      page: v.union(v.null(), v.number()),
      heading: v.union(v.null(), v.string()),
    }),
    createdAt: v.number(),
  })
    .index("by_owner_project", ["ownerId", "projectId"])
    .index("by_document", ["documentId"]),
  /**
   * S12 one embedding row per current-version chunk, kept out of
   * `documentChunks` so ordinary chunk reads never load a 4096-float vector.
   * `model`/`modelVersion`/`dimensions` record who produced the vector and at
   * what width; `commitEmbeddings` rejects any row whose model or dimension
   * does not match the configured qwen3-embedding contract before it is
   * written. The vector index stores the full (untruncated) 4096-dimensional
   * vector, per the S05 filter-and-recheck contract.
   *
   * Vector filter expressions support only `q.eq` and `q.or` — there is no
   * AND combinator — so `scopeKey` is the server-derived `ownerId:projectId`
   * conjunction that lets one equality filter bind both tenant fields before
   * retrieval. `ownerId` and `projectId` stay declared filterFields and are
   * re-enforced on every hit by the ownership recheck.
   */
  chunkEmbeddings: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    scopeKey: v.string(),
    documentId: v.id("documents"),
    chunkId: v.id("documentChunks"),
    contentVersionKey: v.string(),
    seq: v.number(),
    model: v.string(),
    modelVersion: v.string(),
    dimensions: v.number(),
    embedding: v.array(v.float64()),
    embeddedAt: v.number(),
  })
    .index("by_owner_project", ["ownerId", "projectId"])
    .index("by_document", ["documentId"])
    .index("by_document_version", ["documentId", "contentVersionKey"])
    .index("by_chunk", ["chunkId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 4096,
      filterFields: ["ownerId", "projectId", "scopeKey"],
    }),
});
