import type { ConnectionVault } from "../ports/connections.js";
import type { User } from "../ports/identity.js";
import type { Registry } from "../domain/upstream.js";

export type ConnectionState = "connected" | "expired" | "not_connected" | "unavailable";

export interface ConnectionInfo {
  id: string;
  displayName: string;
  toolPrefix: string;
  state: ConnectionState;
  /** Present when the service can be linked (state != connected). */
  connectUrl?: string;
  /** What the token actually carries. Present once linked. */
  grantedScopes?: string[];
  /**
   * Requested but not granted — present only when non-empty, because an empty
   * list is the normal case and noise in every other reading.
   *
   * A provider grants only the scopes its app is configured for, and does so
   * *silently*: the link still reads `connected`, because the OAuth handshake
   * genuinely succeeded. What fails is every subsequent tool call, with whatever
   * unhelpful message the provider chooses — Atlassian's is "We are having
   * trouble completing this action. Please try again shortly.", which names
   * neither the scope nor the tool. Portico held the answer the whole time and
   * did not show it. Now it does.
   */
  missingScopes?: string[];
}

export interface ConnectionsDeps {
  registry: Registry;
  vault: ConnectionVault;
  baseUrl: string;
}

/**
 * Read/'connect'/disconnect use-cases behind the `portico__*` management tools.
 * Merges the static registry (what exists) with the user's vault (what they've
 * linked) into a single view.
 */
export class ConnectionsService {
  constructor(private readonly deps: ConnectionsDeps) {}

  connectUrl(upstreamId: string): string {
    return `${this.deps.baseUrl}/connect/${encodeURIComponent(upstreamId)}`;
  }

  async list(user: User): Promise<ConnectionInfo[]> {
    const conns = new Map(
      (await this.deps.vault.list(user.id)).map((c) => [c.upstreamId, c]),
    );
    return this.deps.registry.list().map((entry) => {
      const conn = conns.get(entry.id);
      let state: ConnectionState;
      if (!this.deps.registry.isConfigured(entry.id)) state = "unavailable";
      else if (!conn || conn.status === "revoked") state = "not_connected";
      else if (conn.status === "expired") state = "expired";
      else state = "connected";

      const actionable = state === "not_connected" || state === "expired";
      const granted = conn?.scopes ?? [];
      const missing = entry.oauth.scopes.filter((s) => !granted.includes(s));
      return {
        id: entry.id,
        displayName: entry.displayName,
        toolPrefix: entry.toolPrefix,
        state,
        ...(actionable ? { connectUrl: this.connectUrl(entry.id) } : {}),
        ...(conn ? { grantedScopes: granted } : {}),
        ...(conn && missing.length ? { missingScopes: missing } : {}),
      };
    });
  }

  async disconnect(user: User, upstreamId: string): Promise<boolean> {
    if (!this.deps.registry.get(upstreamId)) return false;
    await this.deps.vault.delete(user.id, upstreamId);
    return true;
  }
}
