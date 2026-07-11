import type {
  OidcVerifier,
  TokenStore,
  User,
  UserStore,
} from "../ports/identity.js";
import { assertTenantAllowed } from "../domain/identity.js";

export interface IdentityDeps {
  oidc: OidcVerifier;
  users: UserStore;
  tokens: TokenStore;
  /** The single Entra tenant (Okadoc) allowed to log in. */
  allowedTenantId: string;
}

/**
 * Identity use-cases: start an OIDC login and complete it into an Portico user +
 * bearer token. Depends only on ports, so it is tested against in-memory fakes.
 */
export class IdentityService {
  constructor(private readonly deps: IdentityDeps) {}

  beginLogin(state: string, redirectUri: string): string {
    return this.deps.oidc.buildAuthorizationUrl(state, redirectUri);
  }

  /**
   * Exchange the auth code, enforce the Okadoc tenant, upsert the user, and mint
   * a fresh bearer token (shown to the user once for Jean's config).
   */
  async completeLogin(
    code: string,
    redirectUri: string,
  ): Promise<{ user: User; token: string }> {
    const claims = await this.deps.oidc.exchangeCode(code, redirectUri);
    assertTenantAllowed(claims, this.deps.allowedTenantId);

    const user = await this.deps.users.upsertByIdentity({
      issuer: claims.issuer,
      subject: claims.subject,
      email: claims.email,
    });
    const { token } = await this.deps.tokens.mint(user.id, "login");
    return { user, token };
  }
}
