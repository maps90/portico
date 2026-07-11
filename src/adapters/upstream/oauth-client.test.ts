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

  it("throws on a non-2xx token response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad", { status: 400 }),
    );
    await expect(client.exchangeCode(entry, "c", "v", "https://portico/cb")).rejects.toThrow(/failed/);
  });
});
