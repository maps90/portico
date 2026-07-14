import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../../config.js";
import { buildApp, type BuiltApp } from "./server.js";
import { SESSION_COOKIE } from "./identity-routes.js";

const env: Record<string, string> = {
  PORTICO_BASE_URL: "http://localhost",
  PORTICO_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
  PORTICO_SESSION_SECRET: "test-session-secret-value",
  PORTICO_GOOGLE_CLIENT_ID: "cid",
  PORTICO_GOOGLE_CLIENT_SECRET: "sec",
  PORTICO_ALLOWED_DOMAINS: "okadoc.com",
  PORTICO_ARTIFACT_BLOB_ACCOUNT: "acct",
};

describe("artifact host (integration, in-memory)", () => {
  let built: BuiltApp;
  let server: Server;
  let origin: string;
  let token: string;
  let cookie: string;

  beforeAll(async () => {
    built = buildApp({ settings: loadConfig(env), pool: null });
    const user = await built.stores.users.upsertByIdentity({ issuer: "iss", subject: "sub", email: "u@okadoc.com" });
    token = (await built.stores.tokens.mint(user.id, "test")).token;
    cookie = `${SESSION_COOKIE}=${await built.sessions.sign(user.id)}`;
    server = await new Promise<Server>((resolve) => {
      const s = built.app.listen(0, () => resolve(s));
    });
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const publishViaMcp = async (html: string): Promise<string> => {
    const client = new Client({ name: "t", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    try {
      const res = await client.callTool({ name: "portico__publish_html", arguments: { html, title: "Report" } });
      const content = res.content as Array<{ text: string }>;
      const url = content[0]!.text.match(/http:\/\/\S+/)![0];
      return url;
    } finally {
      await client.close();
    }
  };

  it("serves the shell at /visual/:id, framing the artifact in a script-only sandbox", async () => {
    const url = await publishViaMcp("<h1>Quarterly report</h1>");
    const path = new URL(url).pathname;

    const res = await fetch(`${origin}${path}`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('sandbox="allow-scripts"');
    expect(body).not.toContain("allow-same-origin");
    expect(body).toContain(`src="${path}/raw"`);
    // The shell is chrome, not content: the artifact body is not inlined into it.
    expect(body).not.toContain("Quarterly report</h1>");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
  });

  it("serves the artifact bytes at /raw, with script allowed but no way to phone home", async () => {
    const url = await publishViaMcp("<h1>Quarterly report</h1>");
    const path = new URL(url).pathname;

    const res = await fetch(`${origin}${path}/raw`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Quarterly report");

    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'unsafe-inline' 'self'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("frame-ancestors 'none'");
  });

  it("gates /raw on its own — it is a real URL, not an internal detail", async () => {
    const url = await publishViaMcp("<p>secret</p>");
    const path = new URL(url).pathname;

    const res = await fetch(`${origin}${path}/raw`, { redirect: "manual" }); // no cookie
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("returns 404 for /raw once the artifact is revoked", async () => {
    const url = await publishViaMcp("<p>temp</p>");
    const id = new URL(url).pathname.split("/").pop()!;

    const client = new Client({ name: "t", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    await client.callTool({ name: "portico__revoke_artifact", arguments: { id } });
    await client.close();

    const res = await fetch(`${origin}/visual/${id}/raw`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(404);
  });

  it("redirects an unauthenticated viewer to login", async () => {
    const url = await publishViaMcp("<p>hi</p>");
    const path = new URL(url).pathname;
    const res = await fetch(`${origin}${path}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("returns 404 after the artifact is revoked", async () => {
    const url = await publishViaMcp("<p>temp</p>");
    const id = new URL(url).pathname.split("/").pop()!;

    const client = new Client({ name: "t", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    await client.callTool({ name: "portico__revoke_artifact", arguments: { id } });
    await client.close();

    const res = await fetch(`${origin}/visual/${id}`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(404);
  });

  it("permanently redirects the legacy /a/:id link to /visual/:id", async () => {
    const url = await publishViaMcp("<p>legacy</p>");
    const id = new URL(url).pathname.split("/").pop()!;

    const res = await fetch(`${origin}/a/${id}`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/visual/${id}`);
  });

  it("serves vendored chart libraries publicly and immutably", async () => {
    const res = await fetch(`${origin}/vendor/echarts-5.6.0.min.js`); // no cookie on purpose
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
    await res.arrayBuffer();

    const mermaid = await fetch(`${origin}/vendor/mermaid-11.4.1.min.js`);
    expect(mermaid.status).toBe(200);
    await mermaid.arrayBuffer();
  });
});
