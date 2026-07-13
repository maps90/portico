import type { OidcVerifier, TokenStore, User, UserStore } from "../ports/identity.js";
import { assertIdentityAllowed } from "../domain/identity.js";

export interface IdentityDeps {
  oidc: OidcVerifier;
  users: UserStore;
  tokens: TokenStore;
  /** Workspace domains allowed to sign in. Empty = any verified Google account. */
  allowedDomains: readonly string[];
}

/**
 * Identity use-cases: start a Google sign-in and complete it into a Portico user
 * plus a bearer token. Depends only on ports, so it is tested against in-memory
 * fakes.
 */
export class IdentityService {
  constructor(private readonly deps: IdentityDeps) {}

  beginLogin(state: string, redirectUri: string): string {
    return this.deps.oidc.buildAuthorizationUrl(state, redirectUri);
  }

  /**
   * Exchange the auth code, enforce the domain allowlist, upsert the user, and
   * mint a fresh bearer token (shown to the user once, for Jean's config).
   */
  async completeLogin(code: string, redirectUri: string): Promise<{ user: User; token: string }> {
    const claims = await this.deps.oidc.exchangeCode(code, redirectUri);
    assertIdentityAllowed(claims, this.deps.allowedDomains);

    const user = await this.deps.users.upsertByIdentity({
      issuer: claims.issuer,
      subject: claims.subject,
      email: claims.email,
    });
    const { token } = await this.deps.tokens.mint(user.id, "login");
    return { user, token };
  }

  /**
   * Replace every token the user holds with a single fresh one. Raw tokens are
   * unrecoverable (only hashes are stored), so this is the only way to get a new
   * one without signing in again — and it invalidates whatever was in Jean's
   * config, which is the point.
   */
  async regenerateToken(user: User): Promise<{ token: string }> {
    await this.deps.tokens.revokeAllForUser(user.id);
    return this.deps.tokens.mint(user.id, "portal");
  }
}
