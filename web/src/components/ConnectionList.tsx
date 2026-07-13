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
      <div className="card-head">
        <div>
          <h2>Services</h2>
          <p className="hint">
            Linked services are proxied through portico, their tools namespaced by prefix.
          </p>
        </div>
      </div>

      <ul className="services">
        {connections.map((service) => {
          const state = STATE[service.state];
          return (
            <li key={service.id} className="service">
              <ServiceLogo id={service.id} />

              <div className="service-text">
                <div className="service-name">{service.displayName}</div>
                <div className="service-prefix">{service.toolPrefix}__*</div>
              </div>

              <span
                className={state.className}
                {...(service.state === "unavailable" ? { title: envHint(service.id) } : {})}
              >
                <span className="dot" aria-hidden="true" />
                {state.label}
              </span>

              {service.state === "connected" ? (
                <button
                  type="button"
                  className="btn btn-quiet btn-danger-quiet btn-sm service-action"
                  onClick={() => setPending(service)}
                  disabled={busy === service.id}
                  aria-label={`Disconnect ${service.displayName}`}
                >
                  {busy === service.id ? (
                    <LoaderCircle size={14} className="spin" aria-hidden="true" />
                  ) : (
                    <Unplug size={14} aria-hidden="true" />
                  )}
                  Disconnect
                </button>
              ) : service.connectUrl ? (
                // A real navigation, not fetch(): the vendor's consent screen must
                // render top-level — it refuses to be framed or XHR'd.
                <a
                  className="btn btn-outline btn-sm service-action"
                  href={service.connectUrl}
                  aria-label={`Connect ${service.displayName}`}
                >
                  {service.state === "expired" ? "Reconnect" : "Connect"}
                  <ArrowRight size={14} aria-hidden="true" />
                </a>
              ) : (
                // Nothing to do here, but the column still holds so rows stay aligned.
                <span className="service-action" aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ul>

      {error ? (
        <p className="inline-error" role="alert">
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
