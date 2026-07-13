import { useState } from "react";
import { ArrowRight, CircleAlert, LoaderCircle, Unplug } from "lucide-react";
import { api, type Connection, type ConnectionState } from "../api.js";
import { ServiceLogo } from "./ServiceLogo.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

interface Props {
  connections: Connection[];
  onChange: (next: Connection[]) => void;
}

/** Colour never carries the meaning alone — every state also says its name. */
const STATE: Record<ConnectionState, { label: string; className: string }> = {
  connected: { label: "Connected", className: "badge badge-connected" },
  expired: { label: "Expired", className: "badge badge-expired" },
  not_connected: { label: "Not linked", className: "badge" },
  // "Not configured" is the whole story: this instance has no OAuth client for it,
  // so the badge carries the reason and no second column has to repeat it.
  unavailable: { label: "Not configured", className: "badge" },
};

/** The env keys an operator must set to make an unconfigured service linkable. */
const envHint = (id: string): string => {
  const key = `PORTICO_UPSTREAM_${id.replace(/-/g, "_").toUpperCase()}`;
  return `Set ${key}_CLIENT_ID and ${key}_CLIENT_SECRET to enable this service.`;
};

export function ConnectionList({ connections, onChange }: Props): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disconnect = async (service: Connection) => {
    setPending(null);
    setBusy(service.id);
    setError(null);
    try {
      onChange(await api.disconnect(service.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card">
      <h2 className="text-[15px] font-semibold">Services</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
        Sign in to a service once; portico keeps the authorization and proxies its tools,
        namespaced by prefix.
      </p>

      <ul className="mt-4 list-none p-0">
        {connections.map((service) => {
          const state = STATE[service.state];
          const isBusy = busy === service.id;

          return (
            <li
              key={service.id}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 border-t border-line py-3 sm:grid-cols-[auto_1fr_auto_auto]"
            >
              <ServiceLogo id={service.id} />

              <div className="min-w-0">
                <div className="truncate text-[15px] font-medium">{service.displayName}</div>
                <div className="font-mono text-xs text-fg-subtle">{service.toolPrefix}__*</div>
              </div>

              <span
                className={state.className}
                {...(service.state === "unavailable" ? { title: envHint(service.id) } : {})}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
                {state.label}
              </span>

              {service.state === "connected" ? (
                <button
                  type="button"
                  className="btn btn-quiet btn-danger-quiet btn-sm col-start-2 justify-self-start sm:col-auto sm:justify-self-end"
                  onClick={() => setPending(service)}
                  disabled={isBusy}
                  aria-label={`Disconnect ${service.displayName}`}
                >
                  {isBusy ? (
                    <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Unplug size={14} aria-hidden="true" />
                  )}
                  Disconnect
                </button>
              ) : service.connectUrl ? (
                // A real navigation, not fetch(): the vendor's consent screen has to
                // render top-level — it refuses to be framed or XHR'd.
                <a
                  className="btn btn-outline btn-sm col-start-2 justify-self-start sm:col-auto sm:justify-self-end"
                  href={service.connectUrl}
                  aria-label={`Connect ${service.displayName}`}
                >
                  {service.state === "expired" ? "Reconnect" : "Connect"}
                  <ArrowRight size={14} aria-hidden="true" />
                </a>
              ) : (
                // Nothing actionable, but the column still holds so rows stay aligned.
                <span aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ul>

      {error ? (
        <p className="mt-3 flex items-center gap-2 text-[13px] text-danger" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        title={`Disconnect ${pending?.displayName ?? ""}?`}
        body="Its tools stop working until you reconnect. Your gateway token is unaffected."
        confirmLabel="Disconnect"
        onConfirm={() => pending && void disconnect(pending)}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}
