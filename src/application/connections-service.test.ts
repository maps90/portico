import { describe, it, expect, beforeEach } from "vitest";
import { ConnectionsService } from "./connections-service.js";
import { InMemoryConnectionVault } from "../adapters/memory/connection-vault.js";
import { Registry, type UpstreamEntry } from "../domain/upstream.js";
import type { User } from "../ports/identity.js";

const entry = (id: string, configured: boolean): UpstreamEntry => ({
  id,
  displayName: id,
  mcpUrl: configured ? "https://mcp.example/" : "",
  toolPrefix: id,
  kind: "proxied",
  oauth: {
    authorizationUrl: configured ? "https://idp/authorize" : "",
    tokenUrl: configured ? "https://idp/token" : "",
    scopes: [],
    clientId: configured ? "cid" : "",
    clientSecret: configured ? "sec" : "",
  },
});

const user: User = { id: "u1", issuer: "i", subject: "s", email: null, createdAt: new Date() };

describe("ConnectionsService", () => {
  let vault: InMemoryConnectionVault;
  let svc: ConnectionsService;

  beforeEach(() => {
    vault = new InMemoryConnectionVault();
    const registry = new Registry(
      new Map([
        ["atlassian", entry("atlassian", true)],
        ["github", entry("github", false)],
      ]),
    );
    svc = new ConnectionsService({ registry, vault, baseUrl: "https://portico.okadoc.com" });
  });

  it("reports a configured-but-unlinked service as not_connected with a connect URL", async () => {
    const list = await svc.list(user);
    const atl = list.find((c) => c.id === "atlassian")!;
    expect(atl.state).toBe("not_connected");
    expect(atl.connectUrl).toBe("https://portico.okadoc.com/connect/atlassian");
  });

  it("reports an unconfigured service as unavailable with no connect URL", async () => {
    const gh = (await svc.list(user)).find((c) => c.id === "github")!;
    expect(gh.state).toBe("unavailable");
    expect(gh.connectUrl).toBeUndefined();
  });

  it("reflects an active connection as connected", async () => {
    await vault.put({
      userId: user.id,
      upstreamId: "atlassian",
      accessToken: "t",
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      status: "active",
    });
    const atl = (await svc.list(user)).find((c) => c.id === "atlassian")!;
    expect(atl.state).toBe("connected");
    expect(atl.connectUrl).toBeUndefined();
  });

  it("reflects an expired connection as expired", async () => {
    await vault.put({
      userId: user.id,
      upstreamId: "atlassian",
      accessToken: "t",
      refreshToken: "r",
      expiresAt: new Date(0),
      scopes: [],
      status: "expired",
    });
    expect((await svc.list(user)).find((c) => c.id === "atlassian")!.state).toBe("expired");
  });

  it("disconnect returns false for unknown service, true and removes for known", async () => {
    await vault.put({
      userId: user.id,
      upstreamId: "atlassian",
      accessToken: "t",
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      status: "active",
    });
    expect(await svc.disconnect(user, "nope")).toBe(false);
    expect(await svc.disconnect(user, "atlassian")).toBe(true);
    expect(await vault.get(user.id, "atlassian")).toBeNull();
  });
});

describe("granted scopes", () => {
  const withScopes = (requested: string[]): Registry =>
    new Registry(
      new Map([
        [
          "atlassian",
          {
            id: "atlassian",
            displayName: "Atlassian",
            mcpUrl: "https://mcp.example/",
            toolPrefix: "atlassian",
            kind: "proxied",
            oauth: {
              authorizationUrl: "https://idp/authorize",
              tokenUrl: "https://idp/token",
              scopes: requested,
              clientId: "cid",
              clientSecret: "sec",
            },
          } satisfies UpstreamEntry,
        ],
      ]),
    );

  const linked = async (vault: InMemoryConnectionVault, granted: string[]) =>
    vault.put({
      userId: user.id,
      upstreamId: "atlassian",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: granted,
      status: "active",
    });

  it("names the scopes the token is actually missing", async () => {
    // The diagnostic that was not there. Atlassian grants only the scopes the app
    // is configured for -- silently -- and then answers every tool call with
    // "We are having trouble completing this action. Please try again shortly.",
    // which names neither the scope nor the tool. The connection reads "connected"
    // throughout, because the OAuth link IS fine; it is the grant that is short.
    // Portico knew the granted scopes the whole time and told nobody.
    const vault = new InMemoryConnectionVault();
    const svc = new ConnectionsService({
      registry: withScopes(["read:me", "read:jira-work", "offline_access"]),
      vault,
      baseUrl: "https://portico.okadoc.com",
    });
    await linked(vault, ["read:jira-work", "offline_access"]);

    const atl = (await svc.list(user)).find((c) => c.id === "atlassian")!;

    expect(atl.state).toBe("connected");
    expect(atl.grantedScopes).toEqual(["read:jira-work", "offline_access"]);
    expect(atl.missingScopes).toEqual(["read:me"]);
  });

  it("says nothing about scopes when the grant is complete", async () => {
    const vault = new InMemoryConnectionVault();
    const svc = new ConnectionsService({
      registry: withScopes(["read:me", "offline_access"]),
      vault,
      baseUrl: "https://portico.okadoc.com",
    });
    await linked(vault, ["offline_access", "read:me"]); // order must not matter

    const atl = (await svc.list(user)).find((c) => c.id === "atlassian")!;

    expect(atl.missingScopes).toBeUndefined();
  });
});
