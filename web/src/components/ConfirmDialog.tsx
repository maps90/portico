import { useEffect, useRef } from "react";

interface Props {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation for destructive actions, on the native `<dialog>` element — it gives
 * focus trapping, Escape-to-dismiss, and backdrop semantics for free, which a
 * hand-rolled div would have to reimplement (usually badly).
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: Props): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      // Fires on Escape and on backdrop close, so cancelling always reaches state.
      onClose={onCancel}
      onCancel={onCancel}
    >
      <h3 id="confirm-title">{title}</h3>
      <p>{body}</p>
      <div className="dialog-actions">
        <button type="button" className="btn btn-outline btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm" onClick={onConfirm} autoFocus>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
