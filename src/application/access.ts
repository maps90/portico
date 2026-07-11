import type { Connection, ConnectionVault } from "../ports/connections.js";
import type { UpstreamOAuthClient } from "../ports/oauth.js";
import type { Registry } from "../domain/upstream.js";

export interface AccessDeps {
  vault: ConnectionVault;
  oauthClient: UpstreamOAuthClient;
  registry: Registry;
  /** Refresh this many ms before expiry. */
  skewMs?: number;
}

/**
 * Provides a fresh access token for (user, upstream): returns the active
 * connection, refreshing it first if it is near/after expiry. On refresh failure
 * (or a non-active / non-refreshable connection) it marks the connection expired
 * and returns null, so the caller can prompt a re-connect.
 */
export class AccessTokenProvider {
  private readonly skewMs: number;
  constructor(private readonly deps: AccessDeps) {
    this.skewMs = deps.skewMs ?? 60_000;
  }

  async getFresh(userId: string, upstreamId: string): Promise<Connection | null> {
    const conn = await this.deps.vault.get(userId, upstreamId);
    if (!conn || conn.status !== "active") return null;

    const expiringSoon =
      conn.expiresAt !== null && conn.expiresAt.getTime() - Date.now() <= this.skewMs;
    if (!expiringSoon) return conn;

    const entry = this.deps.registry.get(upstreamId);
    if (!entry || !conn.refreshToken) {
      await this.markExpired(conn);
      return null;
    }

    try {
      const tokens = await this.deps.oauthClient.refresh(entry, conn.refreshToken);
      const refreshed: Connection = {
        ...conn,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? conn.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes.length ? tokens.scopes : conn.scopes,
        status: "active",
      };
      await this.deps.vault.put(refreshed);
      return refreshed;
    } catch {
      await this.markExpired(conn);
      return null;
    }
  }

  private async markExpired(conn: Connection): Promise<void> {
    await this.deps.vault.put({ ...conn, status: "expired" });
  }
}
