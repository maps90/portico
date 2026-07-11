import type { UpstreamOAuthClient, UpstreamTokens } from "../../ports/oauth.js";
import type { UpstreamEntry } from "../../domain/upstream.js";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Standard OAuth 2.1 auth-code + PKCE client over `fetch`. Provider quirks are
 * carried by the registry entry (extra authorize params, scopes), so one client
 * serves every upstream.
 */
export class FetchUpstreamOAuthClient implements UpstreamOAuthClient {
  buildAuthorizeUrl(
    entry: UpstreamEntry,
    state: string,
    codeChallenge: string,
    redirectUri: string,
  ): string {
    const params = new URLSearchParams({
      client_id: entry.oauth.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: entry.oauth.scopes.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      ...(entry.oauth.authorizeParams ?? {}),
    });
    return `${entry.oauth.authorizationUrl}?${params.toString()}`;
  }

  async exchangeCode(
    entry: UpstreamEntry,
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<UpstreamTokens> {
    return this.tokenRequest(entry, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
  }

  async refresh(entry: UpstreamEntry, refreshToken: string): Promise<UpstreamTokens> {
    const tokens = await this.tokenRequest(entry, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    // Some providers omit a rotated refresh token; keep the existing one.
    if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
    return tokens;
  }

  private async tokenRequest(
    entry: UpstreamEntry,
    fields: Record<string, string>,
  ): Promise<UpstreamTokens> {
    const body = new URLSearchParams({
      client_id: entry.oauth.clientId,
      client_secret: entry.oauth.clientSecret,
      ...fields,
    });
    const res = await fetch(entry.oauth.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
    if (!res.ok) {
      throw new Error(
        `token request to ${entry.id} failed: ${res.status} ${await res.text()}`,
      );
    }
    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) {
      throw new Error(`token response from ${entry.id} missing access_token`);
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
      scopes: json.scope ? json.scope.split(/\s+/).filter(Boolean) : entry.oauth.scopes,
    };
  }
}
