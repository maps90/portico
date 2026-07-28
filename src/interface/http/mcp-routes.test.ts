import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../../config.js";
import { buildApp, type BuiltApp } from "./server.js";
import type { UpstreamGateway } from "../../ports/upstream.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const env: Record<string, string> = {
  PORTICO_BASE_URL: "http://localhost",
  PORTICO_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  PORTICO_SESSION_SECRET: "test-session-secret-value",
  PORTICO_GOOGLE_CLIENT_ID: "cid",
  PORTICO_GOOGLE_CLIENT_SECRET: "sec",
  PORTICO_ALLOWED_DOMAINS: "okadoc.com",
  PORTICO_ARTIFACT_BLOB_ACCOUNT: "acct",
  PORTICO_UPSTREAM_ATLASSIAN_CLIENT_ID: "atl-cid",
  PORTICO_UPSTREAM_ATLASSIAN_CLIENT_SECRET: "atl-sec",
  PORTICO_UPSTREAM_ATLASSIAN_MCP_URL: "https://mcp.atlassian.example/",
};

/**
 * Fake upstream MCP: one tool, echoes calls. Fronted by github, which is the
 * remaining proxied upstream — atlassian is served in-process now (see the
 * registry seed), so it can no longer stand in for the proxy path.
 */
class FakeGateway implements UpstreamGateway {
  async listTools(): Promise<Tool[]> {
    return [{ name: "create_issue", description: "Create an issue", inputSchema: { type: "object" } }];
  }
  async callTool(_url: string, _t: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return { content: [{ type: "text", text: `github ran ${name} with ${JSON.stringify(args)}` }] };
  }
}

describe("/mcp endpoint (integration, in-memory)", () => {
  let built: BuiltApp;
  let server: Server;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    Object.assign(process.env, env);
    built = buildApp({ settings: loadConfig(process.env), pool: null, overrides: { gateway: new FakeGateway() } });
    const user = await built.stores.users.upsertByIdentity({
      issuer: "https://login.microsoftonline.com/okadoc/v2.0",
      subject: "sub-1",
      email: "u@okadoc.com",
    });
    token = (await built.stores.tokens.mint(user.id, "test")).token;
    // Pre-link both: github exercises the proxy, atlassian the builtin Jira tools.
    for (const upstreamId of ["github", "atlassian"]) {
      await built.stores.vault.put({
        userId: user.id,
        upstreamId,
        accessToken: "UP_AT",
        refreshToken: null,
        expiresAt: null,
        scopes: [],
        status: "active",
      });
    }

    server = await new Promise<Server>((resolve) => {
      const s = built.app.listen(0, () => resolve(s));
    });
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    for (const k of Object.keys(env)) delete process.env[k];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const connect = async (bearer: string | null) => {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {},
    });
    await client.connect(transport);
    return client;
  };

  it("rejects a request with no bearer token", async () => {
    await expect(connect(null)).rejects.toThrow();
  });

  it("rejects an invalid bearer token", async () => {
    await expect(connect("portico_not-a-real-token")).rejects.toThrow();
  });

  it("lists Portico tools plus the namespaced proxied upstream tool", async () => {
    const client = await connect(token);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("portico__list_connections");
      expect(names).toContain("portico__connect");
      expect(names).toContain("portico__disconnect");
      // proxied from the linked github upstream, namespaced
      expect(names).toContain("github__create_issue");
      // atlassian is linked too, but serves builtin Jira tools over REST and
      // advertises nothing proxied — the 40 dead mcp.atlassian.com tools are gone.
      expect(names).toContain("jira__search");
      expect(names.filter((n) => n.startsWith("atlassian__"))).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("routes a proxied tool call to the upstream and returns its result", async () => {
    const client = await connect(token);
    try {
      const res = await client.callTool({
        name: "github__create_issue",
        arguments: { summary: "Bug" },
      });
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("github ran create_issue");
      expect(content[0]!.text).toContain("Bug");
    } finally {
      await client.close();
    }
  });

  it("calls portico__list_connections and returns the registry services", async () => {
    const client = await connect(token);
    try {
      const res = await client.callTool({ name: "portico__list_connections", arguments: {} });
      const content = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as Array<{ id: string }>;
      const ids = parsed.map((c) => c.id);
      expect(ids).toContain("atlassian");
      expect(ids).toContain("google-docs");
      expect(ids).toContain("github");
    } finally {
      await client.close();
    }
  });

  it("tells the agent how to write a visual that will actually render", async () => {
    const client = await connect(token);
    try {
      const { tools } = await client.listTools();
      const publish = tools.find((t) => t.name === "portico__publish_html")!;
      const d = publish.description!;

      // The exact vendored paths — an agent cannot guess these.
      expect(d).toContain("/vendor/echarts-5.6.0.min.js");
      expect(d).toContain("/vendor/mermaid-11.4.1.min.js");
      // The failure mode that is silent, and therefore the one worth spelling out.
      expect(d).toMatch(/CDN|external/i);
    } finally {
      await client.close();
    }
  });
});
