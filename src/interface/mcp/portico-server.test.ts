import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { User } from "../../ports/identity.js";
import { buildPorticoServer, type PorticoServerDeps } from "./portico-server.js";

const user: User = { id: "u1", issuer: "i", subject: "s", email: null, createdAt: new Date() };

/** Minimal deps factory: every dep is a no-op stub, overridable per-test. */
function makeDeps(overrides: Partial<PorticoServerDeps> = {}): PorticoServerDeps {
  return {
    connections: { list: async () => [], disconnect: async () => false } as any,
    proxy: {
      listTools: async () => ({ tools: [], errors: [] }),
      callTool: async () => ({ content: [{ type: "text", text: "proxy-hit" }] }),
    } as any,
    artifacts: {} as any,
    builtin: { listTools: async () => [], callTool: async () => null } as any,
    ...overrides,
  };
}

/** Connects a fresh in-memory client to `server`, runs `fn`, then tears both down. */
async function withClient<T>(server: Server, fn: (client: Client) => Promise<T>): Promise<T> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const callList = (server: Server) => withClient(server, (client) => client.listTools());
const callTool = (server: Server, name: string, args: Record<string, unknown>) =>
  withClient(server, (client) => client.callTool({ name, arguments: args }));

describe("buildPorticoServer", () => {
  it("lists builtin tools after portico__* and before proxied, and routes calls", async () => {
    // A stub BuiltinToolsService: advertises jira__search, handles it, else returns null.
    const builtinStub = {
      listTools: async () => [
        { name: "jira__search", description: "d", inputSchema: { type: "object", properties: {} } },
      ],
      callTool: async (_u: unknown, name: string) =>
        name === "jira__search" ? { content: [{ type: "text", text: "builtin-hit" }] } : null,
    } as any;

    const deps = makeDeps({
      builtin: builtinStub,
      proxy: {
        listTools: async () => ({
          tools: [{ name: "atlassian__create_issue", description: "d", inputSchema: { type: "object", properties: {} } }],
          errors: [],
        }),
        callTool: async () => ({ content: [{ type: "text", text: "proxy-hit" }] }),
      } as any,
    });
    const server = await buildPorticoServer(user, deps);

    const listed = await callList(server);
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain("jira__search");
    expect(names.indexOf("jira__search")).toBeGreaterThan(names.indexOf("portico__list_connections"));
    expect(names.indexOf("jira__search")).toBeLessThan(names.indexOf("atlassian__create_issue"));

    const res = await callTool(server, "jira__search", {});
    expect((res.content as Array<{ type: string; text: string }>)[0]!.text).toBe("builtin-hit");
  });

  it("falls through to the proxy when builtin returns null", async () => {
    const deps = makeDeps();
    const server = await buildPorticoServer(user, deps);

    const res = await callTool(server, "atlassian__create_issue", {});
    expect((res.content as Array<{ type: string; text: string }>)[0]!.text).toBe("proxy-hit");
  });
});
