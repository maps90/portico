/** Identity ports: users, bearer tokens, and OIDC verification. */

/** A logged-in Portico identity, keyed by OIDC (issuer, subject). */
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
  /** True when the IdP asserts the email address is verified. */
  emailVerified: boolean;
  /**
   * The organization this identity belongs to, used to enforce the allowed-domain
   * rule. For Google this is the Workspace domain (`hd`), falling back to the
   * email's domain for consumer accounts. Null when unknown.
   */
  workspace: string | null;
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

/** Metadata about an issued bearer token. The raw token is never recoverable. */
export interface TokenSummary {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** Issues and validates the opaque bearer tokens Jean presents on /mcp. */
export interface TokenStore {
  /** Returns the raw token (shown once) after persisting only its hash. */
  mint(userId: string, name: string): Promise<{ token: string }>;
  /** Resolves a presented raw token to its user, or null if unknown/revoked. */
  resolve(rawToken: string): Promise<User | null>;
  revoke(rawToken: string): Promise<void>;
  /** Active tokens for a user — metadata only, since only hashes are stored. */
  listActive(userId: string): Promise<TokenSummary[]>;
  /** Revokes every active token for a user (used when regenerating). */
  revokeAllForUser(userId: string): Promise<void>;
}

/** Verifies an OIDC id_token's signature and core claims (Google adapter). */
export interface OidcVerifier {
  buildAuthorizationUrl(state: string, redirectUri: string): string;
  /** Exchanges an auth code and returns verified id_token claims. */
  exchangeCode(code: string, redirectUri: string): Promise<OidcClaims>;
}
