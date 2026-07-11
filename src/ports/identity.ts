/** Identity ports: users, bearer tokens, and OIDC verification. */

/** A logged-in omni identity, keyed by OIDC (issuer, subject). */
export interface User {
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  createdAt: Date;
}

/** Verified claims extracted from an OIDC id_token. */
export interface OidcClaims {
  issuer: string;
  subject: string;
  email: string | null;
  /** Entra tenant id (`tid`), used to enforce the Okadoc-only rule. */
  tenantId: string | null;
}

/** Persists users and resolves them from OIDC identity. */
export interface UserStore {
  upsertByIdentity(input: {
    issuer: string;
    subject: string;
    email: string | null;
  }): Promise<User>;
  getById(id: string): Promise<User | null>;
}

/** Issues and validates the opaque bearer tokens Jean presents on /mcp. */
export interface TokenStore {
  /** Returns the raw token (shown once) after persisting only its hash. */
  mint(userId: string, name: string): Promise<{ token: string }>;
  /** Resolves a presented raw token to its user, or null if unknown/revoked. */
  resolve(rawToken: string): Promise<User | null>;
  revoke(rawToken: string): Promise<void>;
}

/** Verifies an OIDC id_token's signature and core claims (Entra adapter). */
export interface OidcVerifier {
  buildAuthorizationUrl(state: string, redirectUri: string): string;
  /** Exchanges an auth code and returns verified id_token claims. */
  exchangeCode(code: string, redirectUri: string): Promise<OidcClaims>;
}
