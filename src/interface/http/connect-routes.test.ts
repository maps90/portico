import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadConfig } from "../../config.js";
import { buildApp, type BuiltApp } from "./server.js";
import { SESSION_COOKIE } from "./identity-routes.js";
import type { UpstreamOAuthClient, UpstreamTokens } from "../../ports/oauth.js";
import type { UpstreamEntry } from "../../domain/upstream.js";

const env: Record<string, string> = {
  PORTICO_BASE_URL: "http://localhost",
  PORTICO_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  PORTICO_SESSION_SECRET: "test-session-secret-value",
  PORTICO_GOOGLE_CLIENT_ID: "cid",
  PORTICO_GOOGLE_CLIENT_SECRET: "sec",
  PORTICO_ARTIFACT_BLOB_ACCOUNT: "acct",
  // configure the atlassian upstream so linking is allowed
  PORTICO_UPSTREAM_ATLASSIAN_CLIENT_ID: "atl-cid",
  PORTICO_UPSTREAM_ATLASSIAN_CLIENT_SECRET: "atl-sec",
  PORTICO_UPSTREAM_ATLASSIAN_MCP_URL: "https://mcp.atlassian.example/",
};

class FakeUpstreamOAuth implements UpstreamOAuthClient {
  buildAuthorizeUrl(_e: UpstreamEntry, state: string, challenge: string, redirect: string): string {
    return `https://fake-idp.example/authorize?state=${state}&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirect)}`;
  }
  async exchangeCode(): Promise<UpstreamTokens> {
    return { accessToken: "UP_AT", refreshToken: "UP_RT", expiresAt: new Date(Date.now() + 3600_000), scopes: ["read:jira-work"] };
  }
  async refresh(): Promise<UpstreamTokens> {
    return { accessToken: "UP_AT2", refreshToken: "UP_RT", expiresAt: null, scopes: [] };
  }
}

describe("/connect flow (integration, in-memory)", () => {
  let built: BuiltApp;
  let server: Server;
  let origin: string;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    // Merge env into process.env so buildRegistry sees the upstream creds.
    Object.assign(process.env, env);
    built = buildApp({ settings: loadConfig(process.env), pool: null, overrides: { oauthClient: new FakeUpstreamOAuth() } });
    const user = await built.stores.users.upsertByIdentity({ issuer: "iss", subject: "sub", email: "u@okadoc.com" });
    userId = user.id;
    cookie = `${SESSION_COOKIE}=${await built.sessions.sign(user.id)}`;

    server = await new Promise<Server>((resolve) => {
      const s = built.app.listen(0, () => resolve(s));
    });
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const k of Object.keys(env)) delete process.env[k];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("redirects an unauthenticated /connect to /login", async () => {
    const res = await fetch(`${origin}/connect/atlassian`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("runs the full connect round-trip and stores an active connection", async () => {
    // begin: authenticated → 302 to the upstream authorize URL
    const begin = await fetch(`${origin}/connect/atlassian`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(begin.status).toBe(302);
    const authorizeUrl = new URL(begin.headers.get("location")!);
    expect(authorizeUrl.origin).toBe("https://fake-idp.example");
    const state = authorizeUrl.searchParams.get("state")!;
    expect(authorizeUrl.searchParams.get("redirect_uri")).toContain("/connect/atlassian/callback");

    // callback: exchange + store, then land the browser back on the portal
    const cb = await fetch(`${origin}/connect/atlassian/callback?state=${state}&code=the-code`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get("location")!);
    expect(back.searchParams.get("connected")).toBe("atlassian");

    const conn = await built.stores.vault.get(userId, "atlassian");
    expect(conn?.status).toBe("active");
    expect(conn?.accessToken).toBe("UP_AT");
  });

  it("rejects a replayed state, returning to the portal with an error", async () => {
    const begin = await fetch(`${origin}/connect/atlassian`, { headers: { cookie }, redirect: "manual" });
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;
    await fetch(`${origin}/connect/atlassian/callback?state=${state}&code=c`, { headers: { cookie }, redirect: "manual" });

    const replay = await fetch(`${origin}/connect/atlassian/callback?state=${state}&code=c`, { headers: { cookie }, redirect: "manual" });
    expect(replay.status).toBe(302);
    const back = new URL(replay.headers.get("location")!);
    expect(back.searchParams.get("connect_error")).toBe("expired_link");
    expect(back.searchParams.get("connected")).toBeNull();
  });

  it("returns to the portal with an error when the user declines consent", async () => {
    const declined = await fetch(`${origin}/connect/atlassian/callback?error=access_denied`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(declined.status).toBe(302);
    expect(new URL(declined.headers.get("location")!).searchParams.get("connect_error")).toBe(
      "declined",
    );
  });

  it("redirects the callback to /login when no session is present (CSRF defense)", async () => {
    const begin = await fetch(`${origin}/connect/atlassian`, { headers: { cookie }, redirect: "manual" });
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;
    // No cookie → must not link silently to the state's stored user.
    const cb = await fetch(`${origin}/connect/atlassian/callback?state=${state}&code=c`, { redirect: "manual" });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/login");
  });
});
