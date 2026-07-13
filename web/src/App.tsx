import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LogOut } from "lucide-react";
import { api, NotSignedIn, type Connection, type Me } from "./api.js";
import { Brand } from "./components/Brand.js";
import { SignIn } from "./components/SignIn.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { TokenCard } from "./components/TokenCard.js";
import { ConnectionList } from "./components/ConnectionList.js";
import { PortalSkeleton } from "./components/Skeleton.js";

type Status = "loading" | "signed-out" | "ready" | "error";

/**
 * The portal: sign in with Google, hold one token, link the services it reaches.
 */
export function App(): JSX.Element {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * `silent` refreshes keep the current screen mounted. That matters more than it
   * looks: a rotate reveals the new token inside TokenCard's own state, and dropping
   * back to the skeleton would unmount the card and destroy the one and only
   * chance the user has to copy it.
   */
  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setStatus("loading");
    try {
      const [meResult, connectionResult] = await Promise.all([api.me(), api.connections()]);
      setMe(meResult);
      setConnections(connectionResult);
      setStatus("ready");
    } catch (err) {
      if (err instanceof NotSignedIn) {
        setStatus("signed-out");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === "signed-out") return <SignIn />;

  if (status === "error") {
    return (
      <main className="center-state">
        <CircleAlert size={24} aria-hidden="true" />
        <div>
          <p>Couldn't reach portico.</p>
          <p className="hint">{error}</p>
        </div>
        <button type="button" className="btn btn-outline" onClick={() => void load()}>
          Try again
        </button>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <Brand />
        <div className="topbar-actions">
          {me?.email ? (
            <span className="identity">
              <span className="email">{me.email}</span>
            </span>
          ) : null}
          <ThemeToggle />
          <a className="btn btn-quiet btn-sm" href="/logout" aria-label="Sign out">
            <LogOut size={14} aria-hidden="true" />
            <span className="btn-label">Sign out</span>
          </a>
        </div>
      </header>

      {status === "loading" || !me ? (
        <PortalSkeleton />
      ) : (
        <>
          <p className="lede">
            One token, every service. Link a service and its tools appear in your MCP client
            immediately — the token you already hold doesn't change.
          </p>
          <TokenCard me={me} onRotated={() => void load({ silent: true })} />
          <ConnectionList connections={connections} onChange={setConnections} />
        </>
      )}
    </main>
  );
}
