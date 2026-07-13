import { CircleAlert, CircleCheck, X } from "lucide-react";

export type BannerKind = "success" | "error";

interface Props {
  kind: BannerKind;
  message: string;
  onDismiss: () => void;
}

/**
 * The outcome of a round trip to a vendor's consent screen. Announced politely so a
 * screen reader hears it without the focus being yanked away from wherever the user
 * left it.
 */
export function Banner({ kind, message, onDismiss }: Props): JSX.Element {
  const success = kind === "success";
  const Icon = success ? CircleCheck : CircleAlert;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-4 flex animate-reveal items-center gap-3 rounded-[10px] border px-4 py-3 text-sm ${
        success
          ? "border-accent-line bg-accent-soft text-fg"
          : "border-line bg-danger-soft text-fg"
      }`}
    >
      <Icon
        size={16}
        className={success ? "shrink-0 text-accent" : "shrink-0 text-danger"}
        aria-hidden="true"
      />
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="btn btn-quiet btn-icon -my-1 shrink-0"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
