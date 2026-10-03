import { useCallback, useEffect, useState } from "react";

import type { DocumentsBackend, SourceView } from "../data/documents.js";
import { sourceLocatorLabel, unavailableCopy } from "../documentView.js";
import { dataErrorCode, mapDataError } from "../view.js";
import { serializeRoute } from "../router.js";

type SourceState = { status: "loading" } | { status: "error"; error: unknown } | { status: "loaded"; view: SourceView };

export type SourceViewerScreenProps = {
  projectId: string;
  documentId: string;
  chunkId?: string | undefined;
  contentHash?: string | undefined;
  /** Production port; `null` renders an explicit unavailable state. */
  backend?: DocumentsBackend | null | undefined;
};

/**
 * S22 citation source viewer. Every load goes through the server-side access
 * check: an anonymous or cross-project request surfaces as an error state, an
 * owned-but-deleted or missing source surfaces as the explicit S13
 * `unavailable` state with its reason, and only an owned, ready source renders
 * text. Never a broken link, never a silent empty panel, never a file URL.
 */
export function SourceViewerScreen({ projectId, documentId, chunkId, contentHash, backend }: SourceViewerScreenProps) {
  const [state, setState] = useState<SourceState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    if (backend === null || backend === undefined) return;
    setState({ status: "loading" });
    try {
      const view = await backend.source({ projectId, documentId, chunkId, contentHash });
      setState({ status: "loaded", view });
    } catch (error) {
      setState({ status: "error", error });
    }
  }, [backend, projectId, documentId, chunkId, contentHash]);

  useEffect(() => {
    void load();
  }, [load, attempt]);

  const documentsHref = serializeRoute({ name: "documents", projectId });
  const backLink = (
    <a className="button" href={documentsHref}>
      Back to documents
    </a>
  );

  if (backend === null || backend === undefined) {
    return (
      <section className="screen" aria-labelledby="source-heading">
        <div className="screen-header">
          <h1 id="source-heading">Source</h1>
        </div>
        <div className="state-block" role="alert">
          <p>The source viewer isn’t available in this context.</p>
          {backLink}
        </div>
      </section>
    );
  }

  if (state.status === "loading") {
    return (
      <section className="screen" aria-labelledby="source-heading">
        <div className="screen-header">
          <h1 id="source-heading">Source</h1>
          {backLink}
        </div>
        <p className="state-block" role="status">
          Loading source…
        </p>
      </section>
    );
  }

  if (state.status === "error") {
    const code = dataErrorCode(state.error);
    const denied = code === "NOT_FOUND";
    const copy = denied ? "You don’t have access to this source." : mapDataError(state.error, "project");
    return (
      <section className="screen" aria-labelledby="source-heading">
        <div className="screen-header">
          <h1 id="source-heading">Source</h1>
          {backLink}
        </div>
        <div className="state-block unavailable" role="alert">
          <h2>{denied ? "Access denied" : "Source unavailable"}</h2>
          <p>{copy}</p>
          {denied && <p>It may belong to another project, or this link may be out of date.</p>}
          {!denied && (
            <div className="state-actions">
              <button type="button" className="button button-primary" onClick={() => setAttempt((value) => value + 1)}>
                Try again
              </button>
            </div>
          )}
        </div>
      </section>
    );
  }

  const { view } = state;

  if (view.status === "unavailable") {
    return (
      <section className="screen" aria-labelledby="source-heading">
        <div className="screen-header">
          <h1 id="source-heading">{view.document.filename}</h1>
          {backLink}
        </div>
        <div className="state-block unavailable" role="status">
          <h2>Source unavailable</h2>
          <p>{unavailableCopy(view.reason)}</p>
          <p className="document-meta">
            The citation points at “{view.document.filename}”
            {view.source.page !== null ? `, page ${view.source.page}` : ""}
            {view.source.heading !== null ? ` — ${view.source.heading}` : ""}.
          </p>
        </div>
      </section>
    );
  }

  const focusLabel = sourceLocatorLabel(view.focus);
  const cited = contentHash !== undefined;

  return (
    <section className="screen" aria-labelledby="source-heading">
      <div className="screen-header">
        <h1 id="source-heading">{view.document.filename}</h1>
        {backLink}
      </div>

      <p className="source-locator">
        <span className="badge badge-neutral">{focusLabel}</span>
        {cited && <span className="badge badge-progress">Cited source</span>}
      </p>

      {view.before.length > 0 && (
        <section className="source-neighbours" aria-label="Earlier in this document">
          <h2>Earlier in this document</h2>
          <ol className="source-context">
            {view.before.map((chunk) => (
              <li key={chunk.chunkId}>
                <a className="source-context-link" href={serializeRoute({ name: "source", projectId, documentId, chunkId: chunk.chunkId })}>
                  {sourceLocatorLabel(chunk)}
                </a>
                <p className="source-context-text">{chunk.text}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <article className="source-focus" aria-label={`Passage: ${focusLabel}`}>
        <p className="source-text">{view.focus.text}</p>
      </article>

      {view.after.length > 0 && (
        <section className="source-neighbours" aria-label="Later in this document">
          <h2>Later in this document</h2>
          <ol className="source-context">
            {view.after.map((chunk) => (
              <li key={chunk.chunkId}>
                <a className="source-context-link" href={serializeRoute({ name: "source", projectId, documentId, chunkId: chunk.chunkId })}>
                  {sourceLocatorLabel(chunk)}
                </a>
                <p className="source-context-text">{chunk.text}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
