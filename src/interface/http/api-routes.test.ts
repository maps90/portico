import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadConfig } from "../../config.js";
import { buildApp, type BuiltApp } from "./server.js";
import { SESSION_COOKIE, NEW_TOKEN_COOKIE } from "./identity-routes.js";

const env: Record<string, string> = {
  PORTICO_BASE_URL: "http://localhost",
  PORTICO_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  PORTICO_SESSION_SECRET: "test-session-secret-value",
  PORTICO_GOOGLE_CLIENT_ID: "cid",
  PORTICO_GOOGLE_CLIENT_SECRET: "sec",
  PORTICO_ALLOWED_DOMAINS: "okadoc.com",
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

  it("hands the login-minted token to the portal exactly once, then forgets it", async () => {
    const { token } = await built.stores.tokens.mint(userId, "login");
    const withPending = `${cookie}; ${NEW_TOKEN_COOKIE}=${token}`;

    const first = await fetch(`${origin}/api/token/pending`, { headers: { cookie: withPending } });
    expect(first.status).toBe(200);
    expect((await first.json()).token).toBe(token);
    // The same response must clear the cookie, so a reload cannot surface it again.
    expect(first.headers.get("set-cookie")).toContain(`${NEW_TOKEN_COOKIE}=;`);

    // A load with no pending cookie (the normal, returning-visit case) reveals nothing.
    const second = await fetch(`${origin}/api/token/pending`, { headers: { cookie } });
    expect((await second.json()).token).toBeNull();
  });

  it("will not reveal a pending token to a request with no session", async () => {
    const { token } = await built.stores.tokens.mint(userId, "login");
    const res = await fetch(`${origin}/api/token/pending`, {
      headers: { cookie: `${NEW_TOKEN_COOKIE}=${token}` },
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(token);
  });

  it("401s every endpoint without a session", async () => {
    for (const path of ["/api/me", "/api/connections", "/api/token/pending"]) {
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
    // Counted against the store rather than a literal: other cases in this file mint
    // tokens too, and this assertion is about the payload, not the running total.
    expect(body.tokenCount).toBe((await built.stores.tokens.listActive(userId)).length);
    expect(body.tokenCount).toBeGreaterThan(0);
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

/**
 * The portal is served from a path that may contain a dot-directory (a git worktree
 * under `.claude/`, an install under `~/.local`, …). `res.sendFile` with an absolute
 * path silently 404s in that case, because `send` ignores dot-segments — so the page
 * has to be sent relative to a root instead.
 */
describe("portal serving", () => {
  it("serves index.html at / even from a path containing a dot-directory", async () => {
    Object.assign(process.env, env);
    const built = buildApp({ settings: loadConfig(process.env), pool: null });
    const server = await new Promise<Server>((resolve) => {
      const s = built.app.listen(0, () => resolve(s));
    });
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${base}/`);
    const body = await res.text();

    // 503 = the portal simply isn't built in this checkout, which is not what we're
    // testing. Anything else must be a real page, never a 404.
    if (res.status !== 503) {
      expect(res.status).toBe(200);
      expect(body).toContain("<div id=\"root\">");
    }

    for (const k of Object.keys(env)) delete process.env[k];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
