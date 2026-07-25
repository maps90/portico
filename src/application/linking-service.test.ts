import { describe, it, expect, beforeEach } from "vitest";
import {
  LinkingService,
  UpstreamNotConfiguredError,
  InvalidOAuthStateError,
} from "./linking-service.js";
import { InMemoryConnectionVault } from "../adapters/memory/connection-vault.js";
import { InMemoryOAuthStateStore } from "../adapters/memory/oauth-state-store.js";
import { Registry, type UpstreamEntry } from "../domain/upstream.js";
import { ConnectionNotFoundError } from "../domain/errors.js";
import type { UpstreamOAuthClient, UpstreamTokens } from "../ports/oauth.js";
import type { User } from "../ports/identity.js";

const configured: UpstreamEntry = {
  id: "atlassian",
  displayName: "Atlassian",
  mcpUrl: "https://mcp.atlassian.com/",
  toolPrefix: "atlassian",
  kind: "proxied",
  oauth: {
    authorizationUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scopes: ["read:jira-work"],
    clientId: "cid",
    clientSecret: "sec",
  },
};
const unconfigured: UpstreamEntry = {
  ...configured,
  id: "github",
  toolPrefix: "github",
  kind: "proxied",
  oauth: { ...configured.oauth, clientId: "", clientSecret: "" },
};

class FakeOAuthClient implements UpstreamOAuthClient {
  public lastAuthorizeUrl = "";
  buildAuthorizeUrl(_e: UpstreamEntry, state: string, challenge: string, redirect: string): string {
    this.lastAuthorizeUrl = `https://idp/authorize?state=${state}&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirect)}`;
    return this.lastAuthorizeUrl;
  }
  async exchangeCode(): Promise<UpstreamTokens> {
    return { accessToken: "AT", refreshToken: "RT", expiresAt: new Date(Date.now() + 3600_000), scopes: ["read:jira-work"] };
  }
  async refresh(): Promise<UpstreamTokens> {
    return { accessToken: "AT2", refreshToken: "RT", expiresAt: null, scopes: [] };
  }
}

const user: User = { id: "u1", issuer: "i", subject: "s", email: null, createdAt: new Date() };

describe("LinkingService", () => {
  let vault: InMemoryConnectionVault;
  let oauthState: InMemoryOAuthStateStore;
  let oauthClient: FakeOAuthClient;
  let svc: LinkingService;

  beforeEach(() => {
    vault = new InMemoryConnectionVault();
    oauthState = new InMemoryOAuthStateStore();
    oauthClient = new FakeOAuthClient();
    const registry = new Registry(
      new Map([
        ["atlassian", configured],
        ["github", unconfigured],
      ]),
    );
    svc = new LinkingService({ registry, vault, oauthState, oauthClient, baseUrl: "https://portico.okadoc.com" });
  });

  it("begin: stores state and returns an authorize URL with the callback redirect", async () => {
    const { authorizeUrl } = await svc.begin(user, "atlassian");
    expect(authorizeUrl).toContain("state=");
    expect(authorizeUrl).toContain("code_challenge=");
    expect(decodeURIComponent(authorizeUrl)).toContain("https://portico.okadoc.com/connect/atlassian/callback");
  });

  it("begin: rejects unknown and unconfigured upstreams", async () => {
    await expect(svc.begin(user, "nope")).rejects.toBeInstanceOf(ConnectionNotFoundError);
    await expect(svc.begin(user, "github")).rejects.toBeInstanceOf(UpstreamNotConfiguredError);
  });

  it("complete: exchanges the code and stores an active connection", async () => {
    const { authorizeUrl } = await svc.begin(user, "atlassian");
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    const { upstreamId, userId } = await svc.complete(state, "auth-code", user.id);
    expect(upstreamId).toBe("atlassian");
    expect(userId).toBe(user.id);

    const conn = await vault.get(user.id, "atlassian");
    expect(conn?.status).toBe("active");
    expect(conn?.accessToken).toBe("AT");
    expect(conn?.refreshToken).toBe("RT");
  });

  it("complete: rejects an unknown/replayed state (single-use)", async () => {
    const { authorizeUrl } = await svc.begin(user, "atlassian");
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    await svc.complete(state, "auth-code", user.id);
    await expect(svc.complete(state, "auth-code", user.id)).rejects.toBeInstanceOf(InvalidOAuthStateError);
  });

  it("complete: rejects when the callback session is a different user (CSRF)", async () => {
    const { authorizeUrl } = await svc.begin(user, "atlassian");
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    await expect(svc.complete(state, "auth-code", "someone-else")).rejects.toBeInstanceOf(
      InvalidOAuthStateError,
    );
    // state was consumed; the legitimate user can no longer replay it either
    expect(await vault.get(user.id, "atlassian")).toBeNull();
  });
});
