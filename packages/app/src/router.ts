import { useSyncExternalStore } from "react";

/** Hash routes for the S21 dashboard; deep links survive sign-in untouched. */
export type Route = { name: "dashboard" } | { name: "new-project" } | { name: "project"; id: string };

export function parseRoute(hash: string): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path === "" || path === "/" || path === "/projects") return { name: "dashboard" };
  if (path === "/projects/new") return { name: "new-project" };
  const match = /^\/projects\/([^/?#]+)$/.exec(path);
  if (match !== null) return { name: "project", id: decodeURIComponent(match[1]) };
  return { name: "dashboard" };
}

export function serializeRoute(route: Route): string {
  switch (route.name) {
    case "dashboard":
      return "#/projects";
    case "new-project":
      return "#/projects/new";
    case "project":
      return `#/projects/${encodeURIComponent(route.id)}`;
  }
}

export function navigate(route: Route): void {
  window.location.hash = serializeRoute(route);
}

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const readHash = () => window.location.hash;

export function useHashRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, readHash, () => "#/projects");
  return parseRoute(hash);
}
