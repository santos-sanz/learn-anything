import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";

import { verifyAgentConnectionToken } from "./convexClient.js";
import { AgentError, agentErrorFromUnknown, jsonError } from "./errors.js";
import { createNanBridge } from "./nanBridge.js";
import { AGENT_SESSION_HEADER, assertUsableBridgeSession, deriveInstanceId, parseBridgeSession, type BridgeSession } from "./scope.js";
import { agentErrorForStorageFailure, isPlatformQuotaError } from "./quota.js";
import { errorMessage, isSdkControlFrame, parseClientMessage } from "./protocol.js";

type SessionRow = {
  connection_id: string;
  token: string;
  owner_id: string;
  project_id: string;
  last_verified_at: number;
  expires_at: number;
};

type ScopeRow = {
  owner_id: string;
  project_id: string;
};

const SESSION_FATAL_CODES = new Set([
  "AGENT_TOKEN_MISSING",
  "AGENT_NOT_CONFIGURED",
  "AGENT_VERIFY_UNAVAILABLE",
  "AGENT_VERIFY_FAILED",
  "AGENT_SCOPE_MISMATCH",
  "AGENT_UNAUTHENTICATED",
  "AGENT_SESSION_EXPIRED",
  "AGENT_SESSION_INVALID",
  "AGENT_SESSION_FORGED",
  "CONNECTION_TOKEN_INVALID",
  "CONNECTION_TOKEN_EXPIRED",
  "CONNECTION_TOKEN_REVOKED",
  "CONNECTION_TOKEN_SCOPE",
]);

function quotaError(): AgentError {
  return new AgentError("AGENT_QUOTA_EXCEEDED", undefined, 507);
}

function closeCodeFor(error: AgentError): number {
  if (error.code === "AGENT_QUOTA_EXCEEDED") return 4507;
  if (error.code === "AGENT_SCOPE_MISMATCH") return 4403;
  return 4401;
}

function selectOne<Row>(rows: Iterable<Row>): Row | undefined {
  for (const row of rows) return row;
  return undefined;
}

/**
 * The learner agent instance: one SQLite-backed Durable Object per verified
 * owner+project scope. It holds only the minimal scoped state needed to keep
 * an authenticated WebSocket session alive — the scope binding and one row
 * per open connection — plus the S11 NaN bridge used by the minimal tutor
 * call path. Convex remains the durable store for projects, documents and
 * messages; nothing durable is copied here.
 *
 * Every entry point validates the Convex-verified session before serving:
 * the Worker gate validates before the connection exists, `onConnect`
 * revalidates before the session is registered, and each WebSocket message
 * or HTTP request revalidates the presented connection token against Convex
 * before any state read or provider call.
 */
export class LearnerAgent extends Agent<Cloudflare.Env> {
  static options = { sendIdentityOnConnect: false, hibernate: true };

  /**
   * Test seam for the quota-exhaustion simulation: when set, the next
   * storage write throws this platform-shaped error instead of writing.
   * It is only ever assigned from `runInDurableObject` in tests.
   */
  faultNextStorageWrite: unknown = null;

  private quotaExceeded = false;

  async onStart(): Promise<void> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS agent_scope (instance_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS agent_connection_session (connection_id TEXT PRIMARY KEY, token TEXT NOT NULL, owner_id TEXT NOT NULL, project_id TEXT NOT NULL, last_verified_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
  }

  async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    try {
      this.assertQuotaUsable();
      const session = await this.readBridgeSession(context.request.headers.get(AGENT_SESSION_HEADER));
      await assertUsableBridgeSession(this.requireSecret(), this.instanceName(), session);
      await this.verifySessionToken(session);
      this.bindScope(session);
      this.recordConnection(connection.id, session);
      this.sendTo(connection, {
        type: "session",
        instanceId: session.instanceId,
        ownerId: session.ownerId,
        projectId: session.projectId,
        expiresAt: session.expiresAt,
      });
    } catch (error) {
      const failure = agentErrorFromUnknown(error);
      this.sendTo(connection, errorMessage(failure.code, failure.message));
      connection.close(closeCodeFor(failure), failure.code);
    }
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    try {
      if (typeof message !== "string" || isSdkControlFrame(message)) return;
      const parsed = parseClientMessage(message);
      if (parsed === null) throw new AgentError("AGENT_BAD_MESSAGE", undefined, 400);
      this.assertQuotaUsable();
      const session = await this.requireLiveConnection(connection.id);
      if (parsed.type === "ping") {
        this.sendTo(connection, { type: "pong", serverTime: Date.now() });
        return;
      }
      if (parsed.type === "state.read") {
        this.touchConnection(connection.id);
        this.sendTo(connection, {
          type: "state.read.result",
          instanceId: session.instanceId,
          ownerId: session.ownerId,
          projectId: session.projectId,
          expiresAt: session.expiresAt,
          connections: [...this.getConnections()].length,
        });
        return;
      }
      const bridge = createNanBridge(this.env, { learnerOwnerId: session.ownerId });
      const reply = await bridge.tutor(parsed.text);
      this.sendTo(connection, { type: "tutor.turn.result", turnId: parsed.turnId, reply });
    } catch (error) {
      const failure = agentErrorFromUnknown(error);
      this.sendTo(connection, errorMessage(failure.code, failure.message));
      if (SESSION_FATAL_CODES.has(failure.code)) connection.close(closeCodeFor(failure), failure.code);
    }
  }

  async onClose(connection: Connection): Promise<void> {
    try {
      this.ctx.storage.sql.exec("DELETE FROM agent_connection_session WHERE connection_id = ?", connection.id);
    } catch {
      // A close handler must never throw; expired rows are also swept on connect.
    }
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      if (request.method !== "GET") {
        return jsonError("AGENT_BAD_MESSAGE", "The agent accepts WebSocket upgrades and GET requests only.", 405);
      }
      this.assertQuotaUsable();
      const session = await this.readBridgeSession(request.headers.get(AGENT_SESSION_HEADER));
      await assertUsableBridgeSession(this.requireSecret(), this.instanceName(), session);
      await this.verifySessionToken(session);
      return new Response(
        JSON.stringify({
          ok: true,
          instanceId: session.instanceId,
          ownerId: session.ownerId,
          projectId: session.projectId,
          expiresAt: session.expiresAt,
          connections: [...this.getConnections()].length,
        }),
        { status: 200, headers: { "content-type": "application/json", "cache-control": "private, no-store" } },
      );
    } catch (error) {
      const failure = agentErrorFromUnknown(error);
      return jsonError(failure.code, failure.message, failure.httpStatus);
    }
  }

  private requireSecret(): string {
    const secret = this.env.AGENT_BRIDGE_SECRET ?? "";
    if (secret.length === 0) throw new AgentError("AGENT_NOT_CONFIGURED", undefined, 503);
    return secret;
  }

  private instanceName(): string | undefined {
    // Present for instances addressed by name (how `routeAgentRequest` routes);
    // undefined only if the runtime hides it, in which case scope binding still
    // relies on the HMAC-derived instance id plus the Convex revalidation.
    return this.ctx.id.name;
  }

  private assertQuotaUsable(): void {
    if (this.quotaExceeded) throw quotaError();
  }

  private sendTo(connection: Connection, message: unknown): void {
    connection.send(JSON.stringify(message));
  }

  private async readBridgeSession(headerValue: string | null): Promise<BridgeSession> {
    const session = await parseBridgeSession(this.requireSecret(), headerValue);
    if (session === null) throw new AgentError("AGENT_SESSION_FORGED", undefined, 401);
    return session;
  }

  /** Authoritative Convex revalidation: identity + live owner/project scope. */
  private async verifySessionToken(session: Pick<BridgeSession, "token" | "ownerId" | "projectId">): Promise<void> {
    const result = await verifyAgentConnectionToken(this.env.CONVEX_URL ?? "", session.token);
    if (!result.ok) throw agentErrorFromUnknown(result);
    if (result.ownerId !== session.ownerId || result.projectId !== session.projectId) {
      throw new AgentError("AGENT_SCOPE_MISMATCH", undefined, 403);
    }
    if (Date.now() >= result.expiresAt) throw new AgentError("AGENT_SESSION_EXPIRED", undefined, 401);
  }

  private runPersisted<T>(operation: () => T): T {
    if (this.faultNextStorageWrite !== null) {
      const injected = this.faultNextStorageWrite;
      this.faultNextStorageWrite = null;
      this.storageFailure(injected);
    }
    try {
      return operation();
    } catch (error) {
      this.storageFailure(error);
    }
  }

  private storageFailure(error: unknown): never {
    if (isPlatformQuotaError(error)) {
      this.quotaExceeded = true;
      console.error("agent storage failure: free-plan quota exceeded; operations refused without automatic upgrade");
      throw agentErrorForStorageFailure(error);
    }
    throw agentErrorForStorageFailure(error);
  }

  private bindScope(session: BridgeSession): void {
    this.runPersisted(() => {
      const existing = selectOne(
        this.ctx.storage.sql.exec<ScopeRow>("SELECT owner_id, project_id FROM agent_scope WHERE instance_id = ?", session.instanceId),
      );
      if (existing === undefined) {
        this.ctx.storage.sql.exec(
          "INSERT INTO agent_scope (instance_id, owner_id, project_id, created_at) VALUES (?, ?, ?, ?)",
          session.instanceId,
          session.ownerId,
          session.projectId,
          Date.now(),
        );
        return;
      }
      if (existing.owner_id !== session.ownerId || existing.project_id !== session.projectId) {
        throw new AgentError("AGENT_SCOPE_MISMATCH", undefined, 403);
      }
    });
  }

  private recordConnection(connectionId: string, session: BridgeSession): void {
    this.runPersisted(() => {
      this.ctx.storage.sql.exec("DELETE FROM agent_connection_session WHERE expires_at < ?", Date.now());
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO agent_connection_session (connection_id, token, owner_id, project_id, last_verified_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        connectionId,
        session.token,
        session.ownerId,
        session.projectId,
        Date.now(),
        session.expiresAt,
      );
    });
  }

  private touchConnection(connectionId: string): void {
    this.runPersisted(() => {
      this.ctx.storage.sql.exec("UPDATE agent_connection_session SET last_verified_at = ? WHERE connection_id = ?", Date.now(), connectionId);
    });
  }

  /** Revalidates a WebSocket session with Convex before any state read or call. */
  private async requireLiveConnection(connectionId: string): Promise<BridgeSession> {
    const row = selectOne(
      this.runPersisted(() =>
        this.ctx.storage.sql.exec<SessionRow>("SELECT connection_id, token, owner_id, project_id, last_verified_at, expires_at FROM agent_connection_session WHERE connection_id = ?", connectionId),
      ),
    );
    if (row === undefined) throw new AgentError("AGENT_UNAUTHENTICATED", undefined, 401);
    if (Date.now() >= row.expires_at) throw new AgentError("AGENT_SESSION_EXPIRED", undefined, 401);
    const instanceId = await deriveInstanceId(this.requireSecret(), row.owner_id, row.project_id);
    const session: BridgeSession = {
      token: row.token,
      ownerId: row.owner_id,
      projectId: row.project_id,
      instanceId,
      verifiedAt: row.last_verified_at,
      expiresAt: row.expires_at,
    };
    await assertUsableBridgeSession(this.requireSecret(), await this.instanceName(), session);
    await this.verifySessionToken(session);
    this.touchConnection(connectionId);
    return session;
  }
}

export const learnerAgentEntryPoint = "cloudflare-agent-runtime" as const;
