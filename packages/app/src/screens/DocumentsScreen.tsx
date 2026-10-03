import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { ConfirmDelete } from "../components/ConfirmDelete.js";
import type { DocumentItem, DocumentsBackend } from "../data/documents.js";
import { documentStatusView, formatBytes, formatUploadedAt, mapDocumentError } from "../documentView.js";
import { serializeRoute } from "../router.js";
import { newUploadIdempotencyKey } from "../uploadClient.js";

type ListState = { status: "loading" } | { status: "error" } | { status: "ready"; items: DocumentItem[] };

export type DocumentsScreenProps = {
  projectId: string;
  /** Production port; `null` renders an explicit unavailable state. */
  backend?: DocumentsBackend | null | undefined;
  /** Auto-refresh cadence while a job is live; 0 disables polling (tests). */
  refreshMs?: number;
};

/**
 * S22 document management for one project: upload through the authenticated
 * S08 action, a list whose status badges are derived from the REAL joined job
 * state (queued/running/succeeded/failed/unsupported), a safe retry that the
 * server de-duplicates, and confirmed deletion that drives the bounded cleanup
 * loop. Nothing here marks a document ready optimistically: every transition
 * comes back from the backend.
 */
export function DocumentsScreen({ projectId, backend, refreshMs = 1500 }: DocumentsScreenProps) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedName, setUploadedName] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ file: File; key: string } | null>(null);
  const [retryBusyId, setRetryBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DocumentItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    if (backend === null || backend === undefined) return;
    try {
      const items = await backend.list(projectId);
      setState({ status: "ready", items });
    } catch {
      setState({ status: "error" });
    }
  }, [backend, projectId]);

  useEffect(() => {
    void reload();
  }, [reload, attempt]);

  const processing = state.status === "ready" && state.items.some((item) => documentStatusView(item).processing);
  useEffect(() => {
    if (backend === null || backend === undefined || !processing || refreshMs <= 0) return;
    const handle = setInterval(() => {
      void reload();
    }, refreshMs);
    return () => clearInterval(handle);
  }, [backend, processing, refreshMs, reload]);

  const projectHref = serializeRoute({ name: "project", id: projectId });

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setUploadError(null);
    setUploadedName(null);
    // One idempotency key per selection: retrying the same file reuses it, so
    // the server can never commit the same upload twice.
    setSelection(file === undefined ? null : { file, key: newUploadIdempotencyKey() });
  };

  const handleUpload = async (event: FormEvent) => {
    event.preventDefault();
    if (backend === null || backend === undefined || selection === null || uploadBusy) return;
    setUploadBusy(true);
    setUploadError(null);
    setUploadedName(null);
    try {
      const result = await backend.upload({ projectId, filename: selection.file.name, bytes: selection.file, idempotencyKey: selection.key });
      setSelection(null);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
      setUploadedName(result.filename);
      await reload();
    } catch (caught) {
      // The selection (and its key) is kept so a retry reuses the same key.
      setUploadError(mapDocumentError(caught, "upload"));
    } finally {
      setUploadBusy(false);
    }
  };

  const handleRetry = async (item: DocumentItem) => {
    if (backend === null || backend === undefined) return;
    setRetryBusyId(item.id);
    setActionError(null);
    try {
      await backend.retry(projectId, item.id);
      await reload();
    } catch (caught) {
      setActionError(mapDocumentError(caught, "retry"));
    } finally {
      setRetryBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (backend === null || backend === undefined || pendingDelete === null) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await backend.remove(projectId, pendingDelete.id);
      setPendingDelete(null);
      await reload();
    } catch (caught) {
      setDeleteError(mapDocumentError(caught, "delete"));
    } finally {
      setDeleteBusy(false);
    }
  };

  const cancelDelete = () => {
    if (deleteBusy) return;
    setPendingDelete(null);
    setDeleteError(null);
  };

  if (backend === null || backend === undefined) {
    return (
      <section className="screen" aria-labelledby="documents-heading">
        <div className="screen-header">
          <h1 id="documents-heading">Documents</h1>
        </div>
        <div className="state-block" role="alert">
          <p>Document tools aren’t available in this context.</p>
          <a className="button" href={projectHref}>
            Back to project
          </a>
        </div>
      </section>
    );
  }

  return (
    <section className="screen" aria-labelledby="documents-heading">
      <div className="screen-header">
        <h1 id="documents-heading">Documents</h1>
        <a className="button" href={projectHref}>
          Back to project
        </a>
      </div>

      <p className="screen-intro">Upload PDF, Markdown or plain text up to 10 MB. Each file is processed in the background; the status below is the real job state.</p>

      <form className="upload-form" onSubmit={(event) => void handleUpload(event)}>
        <label className="upload-label" htmlFor="document-upload">
          Add a document
        </label>
        <input
          ref={fileInputRef}
          id="document-upload"
          name="document-upload"
          type="file"
          accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain"
          onChange={handleFileChange}
          disabled={uploadBusy}
        />
        <button type="submit" className="button button-primary" disabled={selection === null || uploadBusy}>
          {uploadBusy ? "Uploading…" : "Upload"}
        </button>
      </form>
      {uploadError !== null && (
        <p className="form-error" role="alert">
          {uploadError}
        </p>
      )}
      {uploadedName !== null && (
        <p className="form-success" role="status">
          {uploadedName} uploaded — waiting to process.
        </p>
      )}

      {state.status === "loading" && (
        <p className="state-block" role="status">
          Loading documents…
        </p>
      )}

      {state.status === "error" && (
        <div className="state-block" role="alert">
          <p>Couldn’t load your documents.</p>
          <button type="button" className="button button-primary" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        </div>
      )}

      {state.status === "ready" && state.items.length === 0 && (
        <div className="state-block onboarding">
          <h2>No documents yet</h2>
          <p>Upload your learning material above. Once processing finishes it becomes searchable for this project only.</p>
        </div>
      )}

      {state.status === "ready" && state.items.length > 0 && (
        <>
          {actionError !== null && (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          )}
          <ul className="document-list">
            {state.items.map((item) => {
              const view = documentStatusView(item);
              const ready = item.status === "ready" && item.job?.status === "succeeded";
              return (
                <li key={item.id}>
                  <article className="card document-card">
                    <h2 className="card-title">{item.filename}</h2>
                    <p className={`badge badge-${view.tone}`} role="status">
                      {view.label}
                    </p>
                    <p className="document-meta">
                      {formatBytes(item.sizeBytes)} · uploaded {formatUploadedAt(item.createdAt)}
                    </p>
                    {view.detail !== null && <p className="document-detail">{view.detail}</p>}
                    <div className="card-actions">
                      {ready && (
                        <a className="button" href={serializeRoute({ name: "source", projectId, documentId: item.id })} aria-label={`Open source of ${item.filename}`}>
                          Open source
                        </a>
                      )}
                      {view.canRetry && (
                        <button type="button" className="button" aria-label={`Retry ${item.filename}`} onClick={() => void handleRetry(item)} disabled={retryBusyId === item.id}>
                          {retryBusyId === item.id ? "Retrying…" : "Retry"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="button button-danger"
                        aria-label={`Delete ${item.filename}`}
                        onClick={() => {
                          setDeleteError(null);
                          setPendingDelete(item);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <ConfirmDelete
        open={pendingDelete !== null}
        projectName={pendingDelete?.filename ?? ""}
        busy={deleteBusy}
        error={deleteError}
        description="This permanently removes the file, its processed text and its ingestion history. Citations that point at it will show as unavailable. This can’t be undone."
        keepLabel="Keep document"
        confirmLabel="Delete document"
        busyLabel="Deleting…"
        onCancel={cancelDelete}
        onConfirm={() => void handleDelete()}
      />
    </section>
  );
}
