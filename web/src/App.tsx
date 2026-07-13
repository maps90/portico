import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LogOut } from "lucide-react";
import { api, NotSignedIn, type Connection, type Me } from "./api.js";
import { Brand } from "./components/Brand.js";
import { SignIn } from "./components/SignIn.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { TokenCard } from "./components/TokenCard.js";
import { ConnectionList } from "./components/ConnectionList.js";
import { PortalSkeleton } from "./components/Skeleton.js";
import { Banner, type BannerKind } from "./components/Banner.js";

type Status = "loading" | "signed-out" | "ready" | "error";

interface Notice {
  kind: BannerKind;
  message: string;
}

const CONNECT_ERRORS: Record<string, string> = {
  declined: "You declined the authorization, so nothing was linked.",
  not_configured: "That service has no OAuth client configured on this instance.",
  unknown_service: "That service isn't in this instance's registry.",
  expired_link: "That connect link had already been used. Try connecting again.",
  invalid_callback: "The provider's response was incomplete. Try connecting again.",
  begin_failed: "Couldn't start the connection. Try again.",
  exchange_failed: "The provider rejected the authorization. Try again.",
};

/**
 * Reads the outcome the connect flow redirected back with, then strips it from the
 * URL — so a refresh doesn't replay a stale "Connected" banner, and the address bar
 * stays clean.
 */
function takeConnectNotice(): Notice | null {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("connected");
  const failed = params.get("connect_error");
  if (!connected && !failed) return null;

  window.history.replaceState({}, "", window.location.pathname);

  if (connected) return { kind: "success", message: `${connected} is connected. Its tools are live now.` };
  return {
    kind: "error",
    message: CONNECT_ERRORS[failed ?? ""] ?? "Couldn't connect that service.",
  };
}

/** The portal: one page — your gateway token, and the services it reaches. */
export function App(): JSX.Element {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(takeConnectNotice);
  const [error, setError] = useState<string | null>(null);

  /**
   * `silent` refreshes keep the current screen mounted. That matters: a rotate holds
   * the revealed token in TokenCard's state, and dropping back to the skeleton would
   * unmount the card and destroy the one chance the user has to copy it.
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

  // Claim the token minted at login, if this load followed one. Separate from load()
  // because it must happen exactly once — the server clears it on read.
  useEffect(() => {
    if (status !== "ready" || newToken) return;
    void api
      .pendingToken()
      .then((token) => token && setNewToken(token))
      .catch(() => {
        /* A missing hand-off is not worth interrupting the page for. */
      });
  }, [status, newToken]);

  if (status === "signed-out") return <SignIn />;

  if (status === "error") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center text-fg-muted">
        <CircleAlert size={24} aria-hidden="true" />
        <div>
          <p>Couldn't reach portico.</p>
          <p className="mt-1 text-[13px]">{error}</p>
        </div>
        <button type="button" className="btn btn-outline" onClick={() => void load()}>
          Try again
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 pb-12 pt-8 md:px-6 md:pb-24 md:pt-12">
      <header className="mb-8 flex items-center justify-between gap-4">
        <Brand />
        <div className="flex min-w-0 items-center gap-2">
          {me?.email ? (
            <span className="max-w-[12ch] truncate text-sm text-fg-muted sm:max-w-[22ch]">
              {me.email}
            </span>
          ) : null}
          <ThemeToggle />
          <a className="btn btn-quiet btn-sm" href="/logout" aria-label="Sign out">
            <LogOut size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Sign out</span>
          </a>
        </div>
      </header>

      {notice ? (
        <Banner kind={notice.kind} message={notice.message} onDismiss={() => setNotice(null)} />
      ) : null}

      {status === "loading" || !me ? (
        <PortalSkeleton />
      ) : (
        <>
          <p className="mb-6 max-w-[62ch] text-fg-muted">
            One token, every service. Link a service and its tools appear in your MCP client
            immediately — the token you already hold doesn't change.
          </p>

          <TokenCard
            me={me}
            newToken={newToken}
            onRotated={(token) => {
              setNewToken(token);
              void load({ silent: true });
            }}
          />

          <ConnectionList connections={connections} onChange={setConnections} />
        </>
      )}
    </main>
  );
}
