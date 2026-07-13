/** Typed client for portico's `/api/*` surface. Authenticated by the session cookie. */

export interface TokenSummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Me {
  id: string;
  email: string | null;
  tokenCount: number;
  tokens: TokenSummary[];
}

export type ConnectionState = "connected" | "expired" | "not_connected" | "unavailable";

export interface Connection {
  id: string;
  displayName: string;
  toolPrefix: string;
  state: ConnectionState;
  connectUrl?: string;
}

/** Thrown when the session cookie is missing or expired. */
export class NotSignedIn extends Error {
  constructor() {
    super("not signed in");
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      // Cross-site pages cannot set custom headers, so this is what proves the
      // request came from the portal and not from a forged form.
      "x-portico-portal": "1",
      ...init?.headers,
    },
  });
  if (res.status === 401) throw new NotSignedIn();
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  me: () => request<Me>("/api/me"),

  connections: () =>
    request<{ connections: Connection[] }>("/api/connections").then((r) => r.connections),

  /**
   * Claims the token minted during login, if this page load followed one. The server
   * returns it once and clears it, so a refresh yields null — call it exactly once,
   * on mount, and hold the result.
   */
  pendingToken: () => request<{ token: string | null }>("/api/token/pending").then((r) => r.token),

  disconnect: (id: string) =>
    request<{ connections: Connection[] }>(`/api/connections/${encodeURIComponent(id)}/disconnect`, {
      method: "POST",
    }).then((r) => r.connections),

  /** Mints a new bearer token and revokes the old ones. Returned once, never again. */
  rotateToken: () => request<{ token: string }>("/api/token/rotate", { method: "POST" }),
};
