import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadConfig } from "../../config.js";
import { buildApp, type BuiltApp } from "./server.js";
import { SESSION_COOKIE } from "./identity-routes.js";

const env: Record<string, string> = {
  PORTICO_BASE_URL: "http://localhost",
  PORTICO_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  PORTICO_SESSION_SECRET: "test-session-secret-value",
  PORTICO_GOOGLE_CLIENT_ID: "cid",
  PORTICO_GOOGLE_CLIENT_SECRET: "sec",
  // atlassian configured (linkable); github left unconfigured (unavailable)
  PORTICO_UPSTREAM_ATLASSIAN_CLIENT_ID: "atl-cid",
  PORTICO_UPSTREAM_ATLASSIAN_CLIENT_SECRET: "atl-sec",
  PORTICO_UPSTREAM_ATLASSIAN_MCP_URL: "https://mcp.atlassian.example/",
};

/** The portal's requests: session cookie + the header a cross-site page can't set. */
const portal = (cookie: string) => ({ cookie, "x-portico-portal": "1" });

describe("/api (portal surface, in-memory)", () => {
  let built: BuiltApp;
  let server: Server;
  let origin: string;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    Object.assign(process.env, env);
    built = buildApp({ settings: loadConfig(process.env), pool: null });
    const user = await built.stores.users.upsertByIdentity({
      issuer: "https://accounts.google.com",
      subject: "sub-1",
      email: "u@okadoc.com",
    });
    userId = user.id;
    cookie = `${SESSION_COOKIE}=${await built.sessions.sign(user.id)}`;
    await built.stores.tokens.mint(userId, "login");

    server = await new Promise<Server>((resolve) => {
      const s = built.app.listen(0, () => resolve(s));
    });
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const k of Object.keys(env)) delete process.env[k];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("401s every endpoint without a session", async () => {
    for (const path of ["/api/me", "/api/connections"]) {
      const res = await fetch(`${origin}${path}`);
      expect(res.status).toBe(401);
      expect((await res.json()).loginUrl).toBe("/login");
    }
    const post = await fetch(`${origin}/api/token/rotate`, {
      method: "POST",
      headers: { "x-portico-portal": "1" },
    });
    expect(post.status).toBe(401);
  });

  it("returns the signed-in user and token metadata, never a raw token", async () => {
    const res = await fetch(`${origin}/api/me`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("u@okadoc.com");
    expect(body.tokenCount).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(/token"\s*:\s*"[a-z0-9_-]{20,}/i);
  });

  it("lists every upstream with its state and a connect URL where linkable", async () => {
    const res = await fetch(`${origin}/api/connections`, { headers: { cookie } });
    const { connections } = await res.json();

    const atlassian = connections.find((c: { id: string }) => c.id === "atlassian");
    expect(atlassian.state).toBe("not_connected");
    expect(atlassian.connectUrl).toContain("/connect/atlassian");

    // No client creds configured → cannot be linked, and no connect URL is offered.
    const github = connections.find((c: { id: string }) => c.id === "github");
    expect(github.state).toBe("unavailable");
    expect(github.connectUrl).toBeUndefined();
  });

  it("disconnects a linked upstream and reports the new state", async () => {
    await built.stores.vault.put({
      userId,
      upstreamId: "atlassian",
      accessToken: "AT",
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      status: "active",
    });

    const res = await fetch(`${origin}/api/connections/atlassian/disconnect`, {
      method: "POST",
      headers: portal(cookie),
    });
    expect(res.status).toBe(200);
    const { connections } = await res.json();
    expect(connections.find((c: { id: string }) => c.id === "atlassian").state).toBe(
      "not_connected",
    );
    expect(await built.stores.vault.get(userId, "atlassian")).toBeNull();
  });

  it("404s a disconnect for an unknown service", async () => {
    const res = await fetch(`${origin}/api/connections/nope/disconnect`, {
      method: "POST",
      headers: portal(cookie),
    });
    expect(res.status).toBe(404);
  });

  it("rotates the bearer token, returning it once and revoking the old one", async () => {
    const { token: old } = await built.stores.tokens.mint(userId, "login");
    expect(await built.stores.tokens.resolve(old)).not.toBeNull();

    const res = await fetch(`${origin}/api/token/rotate`, {
      method: "POST",
      headers: portal(cookie),
    });
    expect(res.status).toBe(200);
    const { token } = await res.json();

    expect((await built.stores.tokens.resolve(token))?.id).toBe(userId);
    expect(await built.stores.tokens.resolve(old)).toBeNull();
    expect(await built.stores.tokens.listActive(userId)).toHaveLength(1);
  });

  it("refuses state-changing requests without the portal header (CSRF)", async () => {
    const res = await fetch(`${origin}/api/token/rotate`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it("refuses state-changing requests from a foreign origin", async () => {
    const res = await fetch(`${origin}/api/token/rotate`, {
      method: "POST",
      headers: { ...portal(cookie), origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});
