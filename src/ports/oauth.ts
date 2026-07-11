import type { UpstreamEntry } from "../domain/upstream.js";

/** Transient CSRF + PKCE state for an in-flight upstream OAuth linking flow. */
export interface OAuthState {
  state: string;
  userId: string;
  upstreamId: string;
  pkceVerifier: string;
  redirect: string | null;
  createdAt: Date;
}

/** Stores in-flight OAuth state; `take` consumes it exactly once (CSRF-safe). */
export interface OAuthStateStore {
  put(s: OAuthState): Promise<void>;
  take(state: string): Promise<OAuthState | null>;
}

/** Tokens returned by an upstream's token endpoint. */
export interface UpstreamTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

/** OAuth 2.1 + PKCE client against a single upstream (auth-code + refresh). */
export interface UpstreamOAuthClient {
  buildAuthorizeUrl(
    entry: UpstreamEntry,
    state: string,
    codeChallenge: string,
    redirectUri: string,
  ): string;
  exchangeCode(
    entry: UpstreamEntry,
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<UpstreamTokens>;
  refresh(entry: UpstreamEntry, refreshToken: string): Promise<UpstreamTokens>;
}
