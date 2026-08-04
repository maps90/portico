import { describe, it, expect, beforeEach } from "vitest";
import { ProxyService } from "./proxy-service.js";
import { AccessTokenProvider } from "./access.js";
import { InMemoryConnectionVault } from "../adapters/memory/connection-vault.js";
import { Registry, type UpstreamEntry } from "../domain/upstream.js";
import type { UpstreamGateway } from "../ports/upstream.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamOAuthClient, UpstreamTokens } from "../ports/oauth.js";
import type { User } from "../ports/identity.js";

const entry = (id: string, prefix: string): UpstreamEntry => ({
  id,
  displayName: id,
  mcpUrl: `https://mcp/${id}`,
  toolPrefix: prefix,
  kind: "proxied",
  oauth: { authorizationUrl: "a", tokenUrl: "t", scopes: [], clientId: "c", clientSecret: "s" },
});

/** A builtin upstream: tools run in-process, so there is no MCP endpoint to dial. */
const builtin = (id: string, prefix: string): UpstreamEntry => ({
  ...entry(id, prefix),
  mcpUrl: "",
  kind: "builtin",
});

const registry = new Registry(
  new Map([
    ["atlassian", entry("atlassian", "atlassian")],
    ["github", entry("github", "github")],
    ["google-drive", builtin("google-drive", "gdrive")],
  ]),
);

class NoRefresh implements UpstreamOAuthClient {
  buildAuthorizeUrl(): string { return ""; }
  async exchangeCode(): Promise<UpstreamTokens> { throw new Error("x"); }
  async refresh(): Promise<UpstreamTokens> { throw new Error("x"); }
}

/**
 * Fake gateway: atlassian serves one tool; github always throws (unreachable).
 * An empty URL throws `TypeError: Invalid URL` exactly as the real transport does
 * -- `new StreamableHTTPClientTransport(new URL(""))` -- which is how a builtin
 * upstream reaching this layer announced itself in production.
 */
class FakeGateway implements UpstreamGateway {
  public calls: Array<{ url: string; token: string; name: string; args: unknown }> = [];
  private assertDialable(mcpUrl: string): void {
    if (mcpUrl === "") throw new TypeError("Invalid URL");
  }
  async listTools(mcpUrl: string): Promise<Tool[]> {
    this.assertDialable(mcpUrl);
    if (mcpUrl.endsWith("/github")) throw new Error("connection refused");
    return [{ name: "create_issue", description: "create", inputSchema: { type: "object" } }];
  }
  async callTool(mcpUrl: string, token: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.assertDialable(mcpUrl);
    this.calls.push({ url: mcpUrl, token, name, args });
    return { content: [{ type: "text", text: `called ${name}` }] };
  }
}

const user: User = { id: "u1", issuer: "i", subject: "s", email: null, createdAt: new Date() };

describe("ProxyService", () => {
  let vault: InMemoryConnectionVault;
  let gateway: FakeGateway;
  let svc: ProxyService;

  beforeEach(async () => {
    vault = new InMemoryConnectionVault();
    gateway = new FakeGateway();
    const access = new AccessTokenProvider({ vault, oauthClient: new NoRefresh(), registry });
    svc = new ProxyService({ registry, vault, access, gateway, baseUrl: "https://portico" });
    await vault.put({ userId: "u1", upstreamId: "atlassian", accessToken: "AT", refreshToken: null, expiresAt: null, scopes: [], status: "active" });
  });

  it("namespaces tools from connected upstreams", async () => {
    const { tools } = await svc.listTools(user);
    expect(tools.map((t) => t.name)).toEqual(["atlassian__create_issue"]);
  });

  it("skips and records an unreachable upstream instead of failing the list", async () => {
    await vault.put({ userId: "u1", upstreamId: "github", accessToken: "AT", refreshToken: null, expiresAt: null, scopes: [], status: "active" });
    const { tools, errors } = await svc.listTools(user);
    expect(tools.map((t) => t.name)).toEqual(["atlassian__create_issue"]);
    expect(errors.map((e) => e.upstreamId)).toEqual(["github"]);
  });

  it("routes a namespaced call to the owning upstream with the original name", async () => {
    const res = await svc.callTool(user, "atlassian__create_issue", { summary: "hi" });
    expect((res.content as Array<{ text: string }>)[0]!.text).toBe("called create_issue");
    expect(gateway.calls[0]).toMatchObject({ url: "https://mcp/atlassian", token: "AT", name: "create_issue", args: { summary: "hi" } });
  });

  it("returns a connect prompt (isError) for a not-connected upstream", async () => {
    const res = await svc.callTool(user, "github__anything", {});
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("https://portico/connect/github");
  });

  it("errors clearly for an unknown tool prefix", async () => {
    const res = await svc.callTool(user, "bogus__tool", {});
    expect(res.isError).toBe(true);
  });

  it("leaves a connected builtin upstream alone -- no dial, no error", async () => {
    // A builtin upstream has no MCP endpoint by definition; BuiltinToolsService
    // serves its tools in-process. Proxying it anyway dialled the empty string and
    // logged `upstream 'google-drive' listTools failed: TypeError: Invalid URL` on
    // every single tools/list -- pure noise that also implied a broken connection
    // when the connection was fine.
    await vault.put({ userId: "u1", upstreamId: "google-drive", accessToken: "AT", refreshToken: null, expiresAt: null, scopes: [], status: "active" });
    const { tools, errors } = await svc.listTools(user);
    expect(tools.map((t) => t.name)).toEqual(["atlassian__create_issue"]);
    expect(errors).toEqual([]);
  });

  it("does not route a builtin prefix into the proxy", async () => {
    // Reaching here means no builtin provider claimed the prefix, so as far as the
    // proxy is concerned the prefix is simply not one of its own. Say that, rather
    // than dialling an empty URL and reporting a transport failure.
    await vault.put({ userId: "u1", upstreamId: "google-drive", accessToken: "AT", refreshToken: null, expiresAt: null, scopes: [], status: "active" });
    const res = await svc.callTool(user, "gdrive__search_files", {});
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("gdrive");
    expect((res.content as Array<{ text: string }>)[0]!.text).not.toContain("Invalid URL");
    expect(gateway.calls).toEqual([]);
  });
});
