import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { OidcClaims, OidcVerifier } from "../../ports/identity.js";

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Space-delimited OIDC scopes. `openid profile email` by default. */
  scope?: string;
}

/**
 * Microsoft Entra (Azure AD) OIDC verifier, single-tenant. Builds the
 * authorization URL, exchanges the auth code at the tenant token endpoint, and
 * verifies the returned id_token against the tenant JWKS.
 */
export class EntraOidcVerifier implements OidcVerifier {
  private readonly authority: string;
  private readonly scope: string;
  private readonly jwks: JWTVerifyGetKey;

  constructor(private readonly cfg: EntraConfig) {
    this.authority = `https://login.microsoftonline.com/${cfg.tenantId}`;
    this.scope = cfg.scope ?? "openid profile email";
    this.jwks = createRemoteJWKSet(new URL(`${this.authority}/discovery/v2.0/keys`));
  }

  buildAuthorizationUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: this.scope,
      state,
    });
    return `${this.authority}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OidcClaims> {
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      scope: this.scope,
    });
    const res = await fetch(`${this.authority}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Entra token exchange failed: ${res.status} ${await res.text()}`);
    }
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error("Entra response missing id_token");

    const { payload } = await jwtVerify(tokens.id_token, this.jwks, {
      audience: this.cfg.clientId,
      issuer: `${this.authority}/v2.0`,
    });

    const email =
      (typeof payload.email === "string" && payload.email) ||
      (typeof payload.preferred_username === "string" && payload.preferred_username) ||
      null;

    return {
      issuer: String(payload.iss),
      subject: String(payload.sub),
      email,
      tenantId: typeof payload.tid === "string" ? payload.tid : null,
    };
  }
}
