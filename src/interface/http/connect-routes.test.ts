import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadConfig } from "../../config.js";
import { buildApp, type BuiltApp } from "./server.js";
import { SESSION_COOKIE } from "./identity-routes.js";
import type { UpstreamOAuthClient, UpstreamTokens } from "../../ports/oauth.js";
import type { UpstreamEntry } from "../../domain/upstream.js";

const env: Record<string, string> = {
  OMNI_BASE_URL: "http://localhost",
  OMNI_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  OMNI_SESSION_SECRET: "test-session-secret-value",
  OMNI_ENTRA_TENANT_ID: "okadoc",
  OMNI_ENTRA_CLIENT_ID: "cid",
  OMNI_ENTRA_CLIENT_SECRET: "sec",
  OMNI_ARTIFACT_BLOB_ACCOUNT: "acct",
  // configure the atlassian upstream so linking is allowed
  OMNI_UPSTREAM_ATLASSIAN_CLIENT_ID: "atl-cid",
  OMNI_UPSTREAM_ATLASSIAN_CLIENT_SECRET: "atl-sec",
  OMNI_UPSTREAM_ATLASSIAN_MCP_URL: "https://mcp.atlassian.example/",
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

    // callback: exchange + store (session cookie required)
    const cb = await fetch(`${origin}/connect/atlassian/callback?state=${state}&code=the-code`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain("Connected");

    const conn = await built.stores.vault.get(userId, "atlassian");
    expect(conn?.status).toBe("active");
    expect(conn?.accessToken).toBe("UP_AT");
  });

  it("rejects a replayed state on the callback", async () => {
    const begin = await fetch(`${origin}/connect/atlassian`, { headers: { cookie }, redirect: "manual" });
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;
    await fetch(`${origin}/connect/atlassian/callback?state=${state}&code=c`, { headers: { cookie }, redirect: "manual" });
    const replay = await fetch(`${origin}/connect/atlassian/callback?state=${state}&code=c`, { headers: { cookie }, redirect: "manual" });
    expect(replay.status).toBe(400);
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
