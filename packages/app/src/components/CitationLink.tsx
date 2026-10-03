import type { ReactNode } from "react";

import { serializeRoute } from "../router.js";

/**
 * One citation as the S13 retrieval action returns it (plus the optional
 * document name a caller may already have). The link is the single way any
 * screen turns a citation into a navigation: it always carries the chunk
 * anchor and the cited content hash, so the viewer can verify freshness
 * server-side instead of guessing.
 */
export type CitationReference = {
  documentId: string;
  chunkId: string;
  contentHash?: string | undefined;
  seq?: number | undefined;
  page?: number | null | undefined;
  heading?: string | null | undefined;
};

/** Accessible link text: heading, else page, else the chunk's position. */
export function citationLabel(citation: CitationReference): string {
  if (citation.heading !== undefined && citation.heading !== null && citation.heading.trim() !== "") return citation.heading;
  if (citation.page !== undefined && citation.page !== null) return `Page ${citation.page}`;
  if (citation.seq !== undefined) return `Section ${citation.seq + 1}`;
  return "Cited source";
}

export type CitationLinkProps = {
  projectId: string;
  citation: CitationReference;
  /** Overrides the derived label; becomes the accessible name. */
  label?: string;
  className?: string;
  children?: ReactNode;
};

/**
 * A citation rendered as a hash link into the S22 source viewer. Access is
 * checked again by the viewer's server query on every open — the href itself
 * carries no token, no file id and no bearer URL.
 */
export function CitationLink({ projectId, citation, label, className, children }: CitationLinkProps) {
  const href = serializeRoute({
    name: "source",
    projectId,
    documentId: citation.documentId,
    chunkId: citation.chunkId,
    contentHash: citation.contentHash,
  });
  const text = children ?? label ?? citationLabel(citation);
  return (
    <a className={className} href={href}>
      {text}
    </a>
  );
}
