import { useMemo, useSyncExternalStore } from "react";

/**
 * Hash routes for the S21 dashboard and the S22 document/source screens; deep
 * links survive sign-in untouched, and a source link carries the citation's
 * chunk anchor plus its cited content hash so the viewer can detect staleness.
 */
export type Route =
  | { name: "dashboard" }
  | { name: "new-project" }
  | { name: "project"; id: string }
  | { name: "documents"; projectId: string }
  | { name: "source"; projectId: string; documentId: string; chunkId?: string | undefined; contentHash?: string | undefined };

export function parseRoute(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const separator = raw.indexOf("?");
  const path = separator === -1 ? raw : raw.slice(0, separator);
  const query = new URLSearchParams(separator === -1 ? "" : raw.slice(separator + 1));
  if (path === "" || path === "/" || path === "/projects") return { name: "dashboard" };
  if (path === "/projects/new") return { name: "new-project" };
  const documents = /^\/projects\/([^/?#]+)\/documents$/.exec(path);
  if (documents !== null) return { name: "documents", projectId: decodeURIComponent(documents[1]) };
  const source = /^\/projects\/([^/?#]+)\/sources\/([^/?#]+)(?:\/([^/?#]+))?$/.exec(path);
  if (source !== null) {
    const contentHash = query.get("hash");
    return {
      name: "source",
      projectId: decodeURIComponent(source[1]),
      documentId: decodeURIComponent(source[2]),
      chunkId: source[3] === undefined ? undefined : decodeURIComponent(source[3]),
      contentHash: contentHash === null || contentHash === "" ? undefined : contentHash,
    };
  }
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
    case "documents":
      return `#/projects/${encodeURIComponent(route.projectId)}/documents`;
    case "source": {
      const base = `#/projects/${encodeURIComponent(route.projectId)}/sources/${encodeURIComponent(route.documentId)}`;
      const anchor = route.chunkId === undefined ? "" : `/${encodeURIComponent(route.chunkId)}`;
      const hash = route.contentHash === undefined ? "" : `?hash=${encodeURIComponent(route.contentHash)}`;
      return `${base}${anchor}${hash}`;
    }
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
  // Parsed routes are memoized so consumers get a stable identity for an
  // unchanged hash instead of a fresh object on every render.
  return useMemo(() => parseRoute(hash), [hash]);
}
