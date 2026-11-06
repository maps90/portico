import { describe, it, expect, vi, afterEach } from "vitest";
import { FetchUpstreamOAuthClient } from "./oauth-client.js";
import type { UpstreamEntry } from "../../domain/upstream.js";

const entry: UpstreamEntry = {
  id: "google-drive",
  displayName: "Google Drive",
  mcpUrl: "https://mcp.example/",
  toolPrefix: "gdrive",
  oauth: {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["drive.readonly", "email"],
    clientId: "cid",
    clientSecret: "sec",
    authorizeParams: { access_type: "offline", prompt: "consent" },
  },
};

describe("FetchUpstreamOAuthClient", () => {
  const client = new FetchUpstreamOAuthClient();

  afterEach(() => vi.restoreAllMocks());

  it("builds an authorize URL with PKCE + provider params", () => {
    const url = new URL(client.buildAuthorizeUrl(entry, "st8", "chal", "https://portico/cb"));
    const q = url.searchParams;
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(q.get("client_id")).toBe("cid");
    expect(q.get("code_challenge")).toBe("chal");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")).toBe("st8");
    expect(q.get("scope")).toBe("drive.readonly email");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("redirect_uri")).toBe("https://portico/cb");
  });

  it("parses a token response and computes an expiry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "a b" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const before = Date.now();
    const tokens = await client.exchangeCode(entry, "code", "verifier", "https://portico/cb");
    expect(tokens.accessToken).toBe("AT");
    expect(tokens.refreshToken).toBe("RT");
    expect(tokens.scopes).toEqual(["a", "b"]);
    expect(tokens.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
  });

  it("keeps the existing refresh token when the provider omits one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "AT2", expires_in: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const tokens = await client.refresh(entry, "OLD_RT");
    expect(tokens.accessToken).toBe("AT2");
    expect(tokens.refreshToken).toBe("OLD_RT");
  });

  it("joins scopes with the entry's separator, for Slack's comma list", () => {
    const slack = { ...entry, oauth: { ...entry.oauth, scopes: ["chat:write", "reactions:write"], scopeSeparator: "," } };
    const q = new URL(client.buildAuthorizeUrl(slack, "s", "c", "https://portico/cb")).searchParams;
    expect(q.get("scope")).toBe("chat:write,reactions:write");
  });

  it("parses a comma-separated granted scope list (Slack, GitHub)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, access_token: "xo" + "xb-test", token_type: "bot", scope: "chat:write,reactions:write" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    const tokens = await client.exchangeCode(entry, "c", "v", "https://portico/cb");
    expect(tokens.scopes).toEqual(["chat:write", "reactions:write"]);
    // A Slack bot token without rotation: no expiry, no refresh token.
    expect(tokens.expiresAt).toBeNull();
    expect(tokens.refreshToken).toBeNull();
  });

  it("treats Slack's HTTP 200 {ok:false} as a failure and names the error code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "invalid_code" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    await expect(client.exchangeCode(entry, "c", "v", "https://portico/cb")).rejects.toThrow(/failed: invalid_code/);
  });

  describe("Slack user-token grant (user_scope / authed_user)", () => {
    const userSlack: UpstreamEntry = {
      ...entry, id: "slack",
      oauth: { ...entry.oauth, authorizeParams: undefined, scopes: ["chat:write", "reactions:write"],
        scopeSeparator: ",", scopeParam: "user_scope", tokenFrom: "authed_user" },
    };
    const respond = (body: unknown) => vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );

    it("sends the scopes as user_scope and no bot scope", () => {
      const q = new URL(client.buildAuthorizeUrl(userSlack, "s", "c", "https://portico/cb")).searchParams;
      expect(q.get("user_scope")).toBe("chat:write,reactions:write");
      expect(q.has("scope")).toBe(false);
    });

    it("takes the user's token from authed_user, never the bot's top-level one", async () => {
      respond({ ok: true, access_token: "xo" + "xb-bot", scope: "commands",
        authed_user: { id: "U1", access_token: "xo" + "xp-user", token_type: "user", scope: "chat:write,reactions:write" } });
      const tokens = await client.exchangeCode(userSlack, "c", "v", "https://portico/cb");
      expect(tokens.accessToken).toBe("xo" + "xp-user");
      expect(tokens.scopes).toEqual(["chat:write", "reactions:write"]);
      expect(tokens.refreshToken).toBeNull();
    });

    it("refuses to fall back to the bot token when authed_user has none", async () => {
      respond({ ok: true, access_token: "xo" + "xb-bot", scope: "chat:write" });
      await expect(client.exchangeCode(userSlack, "c", "v", "https://portico/cb"))
        .rejects.toThrow(/missing authed_user\.access_token/);
    });
  });

  it("throws on a non-2xx token response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad", { status: 400 }),
    );
    await expect(client.exchangeCode(entry, "c", "v", "https://portico/cb")).rejects.toThrow(/failed/);
  });
});
