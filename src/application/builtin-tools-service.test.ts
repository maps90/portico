import { describe, it, expect } from "vitest";
import { BuiltinToolsService } from "./builtin-tools-service.js";
import type { BuiltinProvider, RestClient } from "../ports/builtin.js";
import type { Connection } from "../ports/connections.js";

const user = { id: "u1", email: "a@okadoc.com" } as any;
const okConn = (id: string): Connection => ({
  userId: "u1", upstreamId: id, accessToken: "T", refreshToken: "R",
  expiresAt: null, scopes: [], status: "active",
});
const provider: BuiltinProvider = {
  id: "atlassian", toolPrefix: "jira",
  tools: [{
    def: { name: "search", description: "d", inputSchema: { type: "object", properties: {} } },
    handle: async (ctx) => ({ content: [{ type: "text", text: (await ctx.http.get("u")).body as string }] }),
  }],
};
const fakeHttp: RestClient = {
  get: async () => ({ status: 200, ok: true, body: "hit" }),
  post: async () => ({ status: 200, ok: true, body: null }),
  put: async () => ({ status: 204, ok: true, body: null }),
};

const svc = (getFresh: (u: string, id: string) => Promise<Connection | null>) =>
  new BuiltinToolsService({
    providers: [provider], baseUrl: "https://p", makeHttp: () => fakeHttp,
    access: { getFresh } as any,
  });

describe("BuiltinToolsService", () => {
  it("advertises a connected provider's tools, namespaced", async () => {
    const s = svc(async () => okConn("atlassian"));
    const tools = await s.listTools(user);
    expect(tools.map((t) => t.name)).toEqual(["jira__search"]);
  });
  it("omits tools when the provider is not connected", async () => {
    const s = svc(async () => null);
    expect(await s.listTools(user)).toEqual([]);
  });
  it("returns null for a non-builtin name (falls through to proxy)", async () => {
    const s = svc(async () => okConn("atlassian"));
    expect(await s.callTool(user, "github__x", {})).toBeNull();
    expect(await s.callTool(user, "notnamespaced", {})).toBeNull();
  });
  it("dispatches a builtin call and passes a token-bound http", async () => {
    const s = svc(async () => okConn("atlassian"));
    const res = await s.callTool(user, "jira__search", {});
    expect(res).toEqual({ content: [{ type: "text", text: "hit" }] });
  });
  it("tells the tool which portico user is calling", async () => {
    // Slack budgets and audits writes per user; without this every caller would
    // share one rate limit and the audit log could not say who asked.
    let seen: string | undefined;
    const p: BuiltinProvider = { ...provider, tools: [{ ...provider.tools[0]!,
      handle: async (ctx) => { seen = ctx.userId; return { content: [] }; } }] };
    const s = new BuiltinToolsService({
      providers: [p], baseUrl: "https://p", makeHttp: () => fakeHttp,
      access: { getFresh: async () => okConn("atlassian") } as any,
    });
    await s.callTool(user, "jira__search", {});
    expect(seen).toBe("u1");
  });

  it("prompts reconnect when the token is unavailable", async () => {
    const s = svc(async () => null);
    const res = await s.callTool(user, "jira__search", {});
    expect(res!.isError).toBe(true);
    expect((res!.content[0] as any).text).toContain("https://p/connect/atlassian");
  });
});
