import { useEffect, useRef } from "react";

export type ConfirmDeleteProps = {
  open: boolean;
  /** The item being deleted; it appears in the default title. */
  projectName: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  /** Copy overrides; the defaults describe S21 project deletion. */
  description?: string;
  keepLabel?: string;
  confirmLabel?: string;
  busyLabel?: string;
};

/**
 * Explicit, modal confirmation for a destructive delete. The native `<dialog>`
 * supplies focus trapping, Escape-to-close and `aria-modal`; the safe choice is
 * focused first and the destructive button is last, so it is the default one.
 * The parent blocks closing while a delete is in flight. S21 uses the project
 * defaults; S22 passes document-specific copy for document deletion.
 */
export function ConfirmDelete({ open, projectName, busy, error, onCancel, onConfirm, description, keepLabel, confirmLabel, busyLabel }: ConfirmDeleteProps) {
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
  const safeLabel = keepLabel ?? "Keep project";
  const destructiveLabel = confirmLabel ?? "Delete project";

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
      <p id="confirm-delete-description">
        {description ?? "This permanently removes the project, its goals, sessions and messages. This can’t be undone."}
      </p>
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="confirm-actions">
        <button type="button" className="button" onClick={requestCancel} disabled={busy} autoFocus>
          {safeLabel}
        </button>
        <button type="button" className="button button-danger" onClick={() => void onConfirm()} disabled={busy}>
          {busy ? (busyLabel ?? "Deleting…") : destructiveLabel}
        </button>
      </div>
    </dialog>
  );
}
