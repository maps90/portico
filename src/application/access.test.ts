import { describe, it, expect, beforeEach } from "vitest";
import { AccessTokenProvider } from "./access.js";
import { InMemoryConnectionVault } from "../adapters/memory/connection-vault.js";
import { Registry, type UpstreamEntry } from "../domain/upstream.js";
import type { UpstreamOAuthClient, UpstreamTokens } from "../ports/oauth.js";
import type { Connection } from "../ports/connections.js";

const entry: UpstreamEntry = {
  id: "atlassian",
  displayName: "Atlassian",
  mcpUrl: "https://mcp/",
  toolPrefix: "atlassian",
  kind: "proxied",
  oauth: { authorizationUrl: "a", tokenUrl: "t", scopes: [], clientId: "c", clientSecret: "s" },
};

class RefreshStub implements UpstreamOAuthClient {
  constructor(private readonly behaviour: "ok" | "fail") {}
  buildAuthorizeUrl(): string {
    return "";
  }
  async exchangeCode(): Promise<UpstreamTokens> {
    throw new Error("unused");
  }
  async refresh(): Promise<UpstreamTokens> {
    if (this.behaviour === "fail") throw new Error("refresh failed");
    return { accessToken: "NEW_AT", refreshToken: "NEW_RT", expiresAt: new Date(Date.now() + 3600_000), scopes: [] };
  }
}

const conn = (over: Partial<Connection>): Connection => ({
  userId: "u1",
  upstreamId: "atlassian",
  accessToken: "OLD_AT",
  refreshToken: "OLD_RT",
  expiresAt: null,
  scopes: [],
  status: "active",
  ...over,
});

const registry = new Registry(new Map([["atlassian", entry]]));

describe("AccessTokenProvider", () => {
  let vault: InMemoryConnectionVault;
  beforeEach(() => {
    vault = new InMemoryConnectionVault();
  });

  it("returns an active, non-expiring connection unchanged", async () => {
    await vault.put(conn({ expiresAt: new Date(Date.now() + 3600_000) }));
    const p = new AccessTokenProvider({ vault, oauthClient: new RefreshStub("ok"), registry });
    const fresh = await p.getFresh("u1", "atlassian");
    expect(fresh?.accessToken).toBe("OLD_AT");
  });

  it("refreshes a token that is near expiry and persists the new one", async () => {
    await vault.put(conn({ expiresAt: new Date(Date.now() + 5_000) }));
    const p = new AccessTokenProvider({ vault, oauthClient: new RefreshStub("ok"), registry });
    const fresh = await p.getFresh("u1", "atlassian");
    expect(fresh?.accessToken).toBe("NEW_AT");
    expect((await vault.get("u1", "atlassian"))?.accessToken).toBe("NEW_AT");
  });

  it("marks the connection expired and returns null when refresh fails", async () => {
    await vault.put(conn({ expiresAt: new Date(Date.now() - 1000) }));
    const p = new AccessTokenProvider({ vault, oauthClient: new RefreshStub("fail"), registry });
    expect(await p.getFresh("u1", "atlassian")).toBeNull();
    expect((await vault.get("u1", "atlassian"))?.status).toBe("expired");
  });

  it("returns null for an expired or missing connection", async () => {
    const p = new AccessTokenProvider({ vault, oauthClient: new RefreshStub("ok"), registry });
    expect(await p.getFresh("u1", "atlassian")).toBeNull();
    await vault.put(conn({ status: "expired" }));
    expect(await p.getFresh("u1", "atlassian")).toBeNull();
  });
});
