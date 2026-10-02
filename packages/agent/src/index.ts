import { routeAgentRequest } from "agents";

import { jsonError } from "./errors.js";
import { gateAgentRequest } from "./gate.js";
import { AGENT_ROUTE_PREFIX, AGENT_SESSION_PATH } from "./routes.js";
import { handleSessionRequest } from "./sessionEndpoint.js";

export { LearnerAgent, learnerAgentEntryPoint } from "./learnerAgent.js";
export { AGENT_SESSION_PATH, agentConnectPath } from "./routes.js";

/**
 * S07 agent runtime entry point: a Cloudflare Worker that hosts learner agents
 * with the Agents SDK on the Workers Free plan.
 *
 * - `POST /agent/session` exchanges a Convex-issued connection token for the
 *   owner-scoped agent instance path (and performs reconnect rotation).
 * - Everything under `/agent/learner-agent/:instanceId` is gated before it
 *   reaches a Durable Object: the Worker verifies the token against Convex and
 *   checks the instance binding in `onBeforeConnect` (WebSocket) and
 *   `onBeforeRequest` (HTTP), so no connection, state read, call or reconnect
 *   starts without a valid, in-scope, Convex-verified identity.
 */
export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === AGENT_SESSION_PATH) {
      return handleSessionRequest(request, env);
    }
    const routed = await routeAgentRequest(request, env, {
      prefix: AGENT_ROUTE_PREFIX,
      onBeforeConnect: async (connectRequest, route) => gateAgentRequest(connectRequest, env, route),
      onBeforeRequest: async (httpRequest, route) => gateAgentRequest(httpRequest, env, route),
    });
    if (routed !== null && routed !== undefined) return routed;
    return jsonError("AGENT_NOT_FOUND", "No agent route matches this path.", 404);
  },
};
