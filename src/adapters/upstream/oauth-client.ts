import type { UpstreamOAuthClient, UpstreamTokens } from "../../ports/oauth.js";
import type { UpstreamEntry } from "../../domain/upstream.js";

interface TokenFields {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

interface TokenResponse {
  /** Slack, user-token grants: the user's own token, beside (or instead of) the bot's. */
  authed_user?: TokenFields;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  /** Slack: every failure is HTTP 200 with `{ok:false, error}`. */
  ok?: boolean;
  error?: string;
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
      [entry.oauth.scopeParam ?? "scope"]: entry.oauth.scopes.join(entry.oauth.scopeSeparator ?? " "),
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
    // Slack reports a bad code, a mismatched redirect_uri or a wrong secret as a
    // 200 whose body says `ok:false`. Without this it surfaced as "missing
    // access_token", which names none of those. Only the error code is quoted --
    // the body of a successful-looking response is never echoed.
    if (json.ok === false) {
      throw new Error(`token request to ${entry.id} failed: ${json.error ?? "ok:false"}`);
    }
    // A user-token grant (Slack `user_scope`) puts the user's token under
    // `authed_user`. The top-level access_token, if any, is the bot's. Taking that
    // one would post as the app, which is exactly what a user grant is meant to avoid,
    // so a missing authed_user token is an error, never a fallback.
    const t: TokenFields = entry.oauth.tokenFrom === "authed_user" ? (json.authed_user ?? {}) : json;
    if (!t.access_token) {
      const where = entry.oauth.tokenFrom === "authed_user" ? "authed_user.access_token" : "access_token";
      throw new Error(`token response from ${entry.id} missing ${where}`);
    }
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
      // Space-separated per RFC 6749; Slack and GitHub return them comma-separated.
      scopes: t.scope ? t.scope.split(/[\s,]+/).filter(Boolean) : entry.oauth.scopes,
    };
  }
}
