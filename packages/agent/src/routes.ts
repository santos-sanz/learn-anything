/** URL contract shared by the Worker entry point and the session endpoint. */
export const AGENT_ROUTE_PREFIX = "agent";
/** Kebab-case of the `LearnerAgent` class / binding, as required by `routeAgentRequest`. */
export const AGENT_INSTANCE_ROUTE = "learner-agent";
export const AGENT_SESSION_PATH = "/agent/session";

export function agentConnectPath(instanceId: string): string {
  return `/${AGENT_ROUTE_PREFIX}/${AGENT_INSTANCE_ROUTE}/${encodeURIComponent(instanceId)}`;
}
