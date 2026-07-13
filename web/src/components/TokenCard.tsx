import { useState } from "react";
import { Check, CircleAlert, Copy, KeyRound, LoaderCircle, RefreshCw } from "lucide-react";
import { api, type Me } from "../api.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

interface Props {
  me: Me;
  /** The one-time value: minted at login, or by the last rotate. Null once claimed. */
  newToken: string | null;
  onRotated: (token: string) => void;
}

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * The bearer token. Tokens are hashed at rest, so portico genuinely cannot redisplay
 * one — the card says so plainly instead of implying a reveal is possible, and frames
 * the only escape hatch (regenerate) as the destructive act it is.
 *
 * The revealed value lives in App, not here: it must outlive any re-render of this
 * card, because the user gets exactly one chance to copy it.
 */
export function TokenCard({ me, newToken, onRotated }: Props): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = me.tokens[0];
  const hasToken = me.tokenCount > 0;

  const rotate = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.rotateToken();
      setCopied(false);
      onRotated(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!newToken) return;
    await navigator.clipboard.writeText(newToken);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <KeyRound size={15} strokeWidth={2} className="text-fg-subtle" aria-hidden="true" />
            Gateway token
          </h2>

          {active ? (
            <p className="mt-1 text-[13px] text-fg-muted">
              Created {when(active.createdAt)}
              {active.lastUsedAt ? ` · last used ${when(active.lastUsedAt)}` : " · never used"}
            </p>
          ) : (
            <p className="mt-1 text-[13px] text-fg-muted">
              No token yet — generate one to connect an MCP client.
            </p>
          )}
        </div>

        <button
          type="button"
          className={`btn btn-sm shrink-0 ${hasToken ? "btn-outline" : "btn-accent"}`}
          onClick={() => (hasToken ? setConfirming(true) : void rotate())}
          disabled={busy}
        >
          {busy ? (
            <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={14} aria-hidden="true" />
          )}
          {busy ? "Generating" : hasToken ? "Regenerate" : "Generate token"}
        </button>
      </div>

      {newToken ? (
        <div className="mt-4 animate-reveal rounded-[10px] border border-accent-line bg-accent-soft p-4">
          <p className="mb-3 flex items-center gap-2 text-[13px]">
            <CircleAlert size={15} strokeWidth={2} className="shrink-0" aria-hidden="true" />
            Copy this now — it is shown only once.
          </p>
          <div className="flex items-stretch gap-2">
            <code className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[13px] tabular-nums [user-select:all]">
              {newToken}
            </code>
            <button
              type="button"
              className="btn btn-outline btn-sm shrink-0"
              onClick={() => void copy()}
              aria-label="Copy token to clipboard"
            >
              {copied ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
          Tokens are stored hashed, so an existing one can never be shown again.
          Regenerating issues a new token and immediately invalidates the old one.
        </p>
      )}

      {error ? (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-danger" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title="Regenerate your token?"
        body="Your current token stops working immediately. Any MCP client using it — Jean included — will need the new value pasted in."
        confirmLabel="Regenerate"
        onConfirm={() => void rotate()}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
