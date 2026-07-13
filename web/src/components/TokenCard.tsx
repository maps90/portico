import { useState } from "react";
import { Check, CircleAlert, Copy, KeyRound, LoaderCircle, RefreshCw } from "lucide-react";
import { api, type Me } from "../api.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

interface Props {
  me: Me;
  onRotated: () => void;
}

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * The bearer token. Tokens are hashed at rest, so portico cannot redisplay an
 * existing one — the card says so plainly rather than implying a reveal is possible,
 * and the only escape hatch (regenerate) is framed as the destructive act it is.
 */
export function TokenCard({ me, onRotated }: Props): JSX.Element {
  const [fresh, setFresh] = useState<string | null>(null);
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
      setFresh(token);
      setCopied(false);
      onRotated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!fresh) return;
    await navigator.clipboard.writeText(fresh);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>
            <KeyRound size={15} strokeWidth={2} aria-hidden="true" />
            Gateway token
          </h2>
          {active ? (
            <p className="token-meta">
              Created {when(active.createdAt)}
              {active.lastUsedAt ? ` · last used ${when(active.lastUsedAt)}` : " · never used"}
            </p>
          ) : (
            <p className="hint">No token yet — generate one to connect an MCP client.</p>
          )}
        </div>

        <button
          type="button"
          className={hasToken ? "btn btn-outline btn-sm" : "btn btn-accent btn-sm"}
          onClick={() => (hasToken ? setConfirming(true) : void rotate())}
          disabled={busy}
        >
          {busy ? (
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={14} aria-hidden="true" />
          )}
          {busy ? "Generating" : hasToken ? "Regenerate" : "Generate token"}
        </button>
      </div>

      {fresh ? (
        <div className="token-reveal">
          <p className="warn-line">
            <CircleAlert size={15} strokeWidth={2} aria-hidden="true" />
            Copy this now — it is shown only once.
          </p>
          <div className="token-row">
            <code>{fresh}</code>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => void copy()}
              aria-label="Copy token to clipboard"
            >
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : (
        <p className="hint">
          Tokens are stored hashed, so an existing one can never be shown again.
          Regenerating issues a new token and immediately invalidates the old one.
        </p>
      )}

      {error ? (
        <p className="inline-error" role="alert">
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
