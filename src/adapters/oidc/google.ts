import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { OidcClaims, OidcVerifier } from "../../ports/identity.js";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Space-delimited OIDC scopes. `openid email profile` by default. */
  scope?: string;
  /**
   * Workspace domains this instance accepts. When exactly one is configured it
   * is passed as Google's `hd` parameter so the account chooser pre-filters —
   * a UX hint only. The real check is the domain policy, on verified claims.
   */
  allowedDomains?: readonly string[];
  /** Overridable for tests; defaults to Google's production endpoints. */
  endpoints?: GoogleEndpoints;
}

export interface GoogleEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  issuers: string[];
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
  // Google signs id_tokens with either form of the issuer.
  issuers: ["https://accounts.google.com", "accounts.google.com"],
};

/**
 * Google OIDC verifier ("Sign in with Google"). Builds the authorization URL,
 * exchanges the auth code at Google's token endpoint, and verifies the returned
 * id_token against Google's JWKS.
 *
 * This is the *login* client only — it asks for `openid email profile` and
 * nothing else. Linking Google Drive as an upstream is a separate OAuth client
 * with its own scopes, handled by the connection vault.
 */
export class GoogleOidcVerifier implements OidcVerifier {
  private readonly scope: string;
  private readonly endpoints: GoogleEndpoints;
  private readonly jwks: JWTVerifyGetKey;

  constructor(private readonly cfg: GoogleConfig) {
    this.scope = cfg.scope ?? "openid email profile";
    this.endpoints = cfg.endpoints ?? GOOGLE_ENDPOINTS;
    this.jwks = createRemoteJWKSet(new URL(this.endpoints.jwksUrl));
  }

  buildAuthorizationUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: this.scope,
      state,
    });
    const domains = this.cfg.allowedDomains ?? [];
    if (domains.length === 1 && domains[0]) params.set("hd", domains[0]);
    return `${this.endpoints.authorizationUrl}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OidcClaims> {
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    const res = await fetch(this.endpoints.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
    }
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error("Google response missing id_token");

    const { payload } = await jwtVerify(tokens.id_token, this.jwks, {
      audience: this.cfg.clientId,
      issuer: this.endpoints.issuers,
    });

    const email = typeof payload.email === "string" ? payload.email : null;
    // `hd` is only present on Workspace accounts; for consumer accounts fall back
    // to the email domain so the policy has something concrete to match on.
    const hd = typeof payload.hd === "string" ? payload.hd : null;
    const emailDomain = email?.includes("@") ? (email.split("@").pop() ?? null) : null;

    return {
      issuer: String(payload.iss),
      subject: String(payload.sub),
      email,
      emailVerified: payload.email_verified === true,
      workspace: hd ?? emailDomain,
    };
  }
}
