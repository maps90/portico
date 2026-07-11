import type { ConnectionVault } from "../ports/connections.js";
import type { User } from "../ports/identity.js";
import type { OAuthStateStore, UpstreamOAuthClient } from "../ports/oauth.js";
import type { Registry } from "../domain/upstream.js";
import { ConnectionNotFoundError, DomainError } from "../domain/errors.js";
import { generatePkce, randomState } from "../adapters/crypto/pkce.js";

export class UpstreamNotConfiguredError extends DomainError {
  constructor(upstreamId: string) {
    super(`upstream '${upstreamId}' is not configured`, "upstream_not_configured");
  }
}

export class InvalidOAuthStateError extends DomainError {
  constructor() {
    super("invalid or expired OAuth state", "invalid_oauth_state");
  }
}

export interface LinkingDeps {
  registry: Registry;
  vault: ConnectionVault;
  oauthState: OAuthStateStore;
  oauthClient: UpstreamOAuthClient;
  baseUrl: string;
}

/**
 * Upstream OAuth linking use-cases. `begin` starts an auth-code + PKCE flow;
 * `complete` exchanges the code and stores the connection in the vault.
 * Depends only on ports, so it is tested with a fake OAuth client.
 */
export class LinkingService {
  constructor(private readonly deps: LinkingDeps) {}

  redirectUri(upstreamId: string): string {
    return `${this.deps.baseUrl}/connect/${encodeURIComponent(upstreamId)}/callback`;
  }

  /** Returns the upstream authorize URL to redirect the user's browser to. */
  async begin(user: User, upstreamId: string): Promise<{ authorizeUrl: string }> {
    const entry = this.deps.registry.get(upstreamId);
    if (!entry) throw new ConnectionNotFoundError(upstreamId);
    if (!this.deps.registry.isConfigured(upstreamId)) {
      throw new UpstreamNotConfiguredError(upstreamId);
    }

    const { verifier, challenge } = generatePkce();
    const state = randomState();
    await this.deps.oauthState.put({
      state,
      userId: user.id,
      upstreamId,
      pkceVerifier: verifier,
      redirect: null,
      createdAt: new Date(),
    });

    return {
      authorizeUrl: this.deps.oauthClient.buildAuthorizeUrl(
        entry,
        state,
        challenge,
        this.redirectUri(upstreamId),
      ),
    };
  }

  /**
   * Consumes the state, exchanges the code, and stores the connection.
   *
   * `currentUserId` is the browser session's user at callback time. It MUST match
   * the user who began the flow — this binds the linking to the session and
   * prevents OAuth account-linking CSRF (a leaked/replayed state+code cannot link
   * an upstream account into a different user's omni account).
   */
  async complete(
    state: string,
    code: string,
    currentUserId: string,
  ): Promise<{ upstreamId: string; userId: string }> {
    const rec = await this.deps.oauthState.take(state);
    if (!rec) throw new InvalidOAuthStateError();
    if (rec.userId !== currentUserId) throw new InvalidOAuthStateError();

    const entry = this.deps.registry.get(rec.upstreamId);
    if (!entry) throw new ConnectionNotFoundError(rec.upstreamId);

    const tokens = await this.deps.oauthClient.exchangeCode(
      entry,
      code,
      rec.pkceVerifier,
      this.redirectUri(rec.upstreamId),
    );

    await this.deps.vault.put({
      userId: rec.userId,
      upstreamId: rec.upstreamId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      status: "active",
    });

    return { upstreamId: rec.upstreamId, userId: rec.userId };
  }
}
