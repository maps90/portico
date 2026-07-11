import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../../config.js";
import { buildApp, type BuiltApp } from "./server.js";

const env: Record<string, string> = {
  OMNI_BASE_URL: "http://localhost",
  OMNI_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  OMNI_SESSION_SECRET: "test-session-secret-value",
  OMNI_ENTRA_TENANT_ID: "okadoc",
  OMNI_ENTRA_CLIENT_ID: "cid",
  OMNI_ENTRA_CLIENT_SECRET: "sec",
  OMNI_ARTIFACT_BLOB_ACCOUNT: "acct",
};

describe("/mcp endpoint (integration, in-memory)", () => {
  let built: BuiltApp;
  let server: Server;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    built = buildApp({ settings: loadConfig(env), pool: null });
    const user = await built.stores.users.upsertByIdentity({
      issuer: "https://login.microsoftonline.com/okadoc/v2.0",
      subject: "sub-1",
      email: "u@okadoc.com",
    });
    token = (await built.stores.tokens.mint(user.id, "test")).token;

    server = await new Promise<Server>((resolve) => {
      const s = built.app.listen(0, () => resolve(s));
    });
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
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
    await expect(connect("omni_not-a-real-token")).rejects.toThrow();
  });

  it("lists the omni management tools for an authenticated user", async () => {
    const client = await connect(token);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("omni__list_connections");
      expect(names).toContain("omni__connect");
      expect(names).toContain("omni__disconnect");
    } finally {
      await client.close();
    }
  });

  it("calls omni__list_connections and returns the registry services", async () => {
    const client = await connect(token);
    try {
      const res = await client.callTool({ name: "omni__list_connections", arguments: {} });
      const content = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as Array<{ id: string }>;
      const ids = parsed.map((c) => c.id);
      expect(ids).toContain("atlassian");
      expect(ids).toContain("google-drive");
      expect(ids).toContain("github");
    } finally {
      await client.close();
    }
  });
});
