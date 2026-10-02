import { useEffect, useRef } from "react";

export type ConfirmDeleteProps = {
  open: boolean;
  projectName: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
};

/**
 * Explicit, modal confirmation for a destructive delete. The native `<dialog>`
 * supplies focus trapping, Escape-to-close and `aria-modal`; "Keep project" is
 * focused first and the destructive button is last, so the safe choice is the
 * default one. The parent blocks closing while a delete is in flight.
 */
export function ConfirmDelete({ open, projectName, busy, error, onCancel, onConfirm }: ConfirmDeleteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onCancelRef.current();
    };
    dialog.addEventListener("cancel", handleCancel);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    };
  }, [open]);

  if (!open) return null;

  const requestCancel = () => {
    if (!busy) onCancel();
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-title"
      aria-describedby="confirm-delete-description"
    >
      <h2 id="confirm-delete-title">Delete “{projectName}”?</h2>
      <p id="confirm-delete-description">This permanently removes the project, its goals, sessions and messages. This can’t be undone.</p>
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="confirm-actions">
        <button type="button" className="button" onClick={requestCancel} disabled={busy} autoFocus>
          Keep project
        </button>
        <button type="button" className="button button-danger" onClick={() => void onConfirm()} disabled={busy}>
          {busy ? "Deleting…" : "Delete project"}
        </button>
      </div>
    </dialog>
  );
}
