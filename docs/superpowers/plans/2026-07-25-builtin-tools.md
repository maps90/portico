# Builtin Tools (Jira + Google Docs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-process "builtin" tool providers to portico so Jira calls Jira Cloud REST directly (reusing the existing `atlassian` OAuth connection, bypassing the flaky hosted MCP) and Google Docs becomes a new builtin connectable service.

**Architecture:** A new `BuiltinProvider` port and a `BuiltinToolsService` (mirroring `ProxyService`) become a third tool source in `buildPorticoServer`, sitting between the `portico__*` management tools and the proxied upstreams. Providers are adapters that call vendor REST via a small `RestClient`, authenticated with the fresh token from the existing `AccessTokenProvider.getFresh`. The proxy path is untouched.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), `@modelcontextprotocol/sdk`, Vitest, Express. Hexagonal layering per `ARCHITECTURE.md`.

## Global Constraints

- ESM imports use explicit `.js` extensions (NodeNext). Copy this style.
- Tests are colocated `*.test.ts`, run with Vitest; `make test` must stay hermetic — no network, no credentials. Inject fakes.
- Layering: `domain/` imports nothing; `ports/` imports domain types only; `application/` imports `domain/`+`ports/`; `adapters/` implement ports; `interface/` wires in the composition root (`src/interface/http/server.ts`).
- Auth for builtin handlers comes ONLY from `AccessTokenProvider.getFresh(userId, upstreamId): Promise<Connection | null>` — never read the vault directly in a handler.
- Tool prefixes: Jira = `jira`, Google Docs = `gdocs`. Namespacing via `domain/tool-names.ts` (`namespaceTool`/`parseTool`, separator `__`).
- Google OAuth seed MUST set `authorizeParams: { access_type: "offline", prompt: "consent" }` or no refresh token is issued.
- Run the suite with `npm test` (Vitest). Verify a build with `npm run build:api` (tsc).

---

### Task 1: Registry — `kind` field, `isConfigured` fix, `google-docs` seed

**Files:**
- Modify: `src/domain/upstream.ts` (add `kind` to `UpstreamEntry`; fix `isConfigured`)
- Modify: `src/adapters/registry/default-registry.ts` (add `kind` to `Seed`/entries; add `google-docs` seed)
- Test: `src/domain/upstream.test.ts`, `src/adapters/registry/default-registry.test.ts`

**Interfaces:**
- Produces: `UpstreamEntry.kind: "proxied" | "builtin"`; `Registry.isConfigured(id)` returns true for a builtin with OAuth creds even when `mcpUrl === ""`. A registry entry with id `google-docs`, `kind: "builtin"`, `toolPrefix: "gdrive"`-style prefix is NOT used here — Google Docs tools are namespaced by the provider (Task 6), so this seed only supplies OAuth for linking.

- [ ] **Step 1: Write the failing test** (append to `src/domain/upstream.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { Registry, type UpstreamEntry } from "./upstream.js";

const entry = (over: Partial<UpstreamEntry>): UpstreamEntry => ({
  id: "x", displayName: "X", mcpUrl: "", toolPrefix: "x", kind: "proxied",
  oauth: { authorizationUrl: "a", tokenUrl: "t", scopes: [], clientId: "", clientSecret: "" },
  ...over,
});

describe("Registry.isConfigured builtin", () => {
  it("is true for a builtin with creds and no mcpUrl", () => {
    const r = new Registry(new Map([["g", entry({ id: "g", kind: "builtin",
      oauth: { authorizationUrl: "a", tokenUrl: "t", scopes: [], clientId: "c", clientSecret: "s" } })]]));
    expect(r.isConfigured("g")).toBe(true);
  });
  it("is false for a builtin missing creds", () => {
    const r = new Registry(new Map([["g", entry({ id: "g", kind: "builtin" })]]));
    expect(r.isConfigured("g")).toBe(false);
  });
  it("still requires mcpUrl for a proxied upstream", () => {
    const r = new Registry(new Map([["p", entry({ id: "p", kind: "proxied",
      oauth: { authorizationUrl: "a", tokenUrl: "t", scopes: [], clientId: "c", clientSecret: "s" } })]]));
    expect(r.isConfigured("p")).toBe(false); // mcpUrl empty
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/domain/upstream.test.ts`
Expected: FAIL — `kind` not on `UpstreamEntry`, and `isConfigured` requires `mcpUrl`.

- [ ] **Step 3: Edit `src/domain/upstream.ts`**

Add to `UpstreamEntry` (after `toolPrefix`):
```ts
  /** "proxied" = forward to a remote MCP (`mcpUrl`); "builtin" = tools implemented in-process. */
  kind: "proxied" | "builtin";
```
Replace `isConfigured` body with:
```ts
  isConfigured(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    const credsOk =
      e.oauth.clientId !== "" &&
      e.oauth.clientSecret !== "" &&
      e.oauth.authorizationUrl !== "" &&
      e.oauth.tokenUrl !== "";
    if (!credsOk) return false;
    return e.kind === "builtin" ? true : e.mcpUrl !== "";
  }
```

- [ ] **Step 4: Edit `src/adapters/registry/default-registry.ts`**

Add `kind` to the `Seed` interface:
```ts
  kind: "proxied" | "builtin";
```
Add `kind: "proxied"` to the three existing seeds (`atlassian`, `google-drive`, `github`). Append a new seed:
```ts
  {
    id: "google-docs",
    displayName: "Google Docs",
    kind: "builtin",
    defaultMcpUrl: "",
    toolPrefix: "gdocs",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive.file",
      "openid",
      "email",
    ],
    authorizeParams: { access_type: "offline", prompt: "consent" },
  },
```
In `buildRegistry`, set `kind: s.kind` on the constructed `UpstreamEntry`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/domain/upstream.test.ts src/adapters/registry/default-registry.test.ts`
Expected: PASS. (Update any existing registry test that builds a literal `UpstreamEntry` to include `kind: "proxied"`.)

- [ ] **Step 6: Commit**

```bash
git add src/domain/upstream.ts src/adapters/registry/default-registry.ts src/domain/upstream.test.ts src/adapters/registry/default-registry.test.ts
git commit -m "feat(registry): add builtin kind and google-docs seed"
```

---

### Task 2: `BuiltinProvider` port + `RestClient` adapter

**Files:**
- Create: `src/ports/builtin.ts`
- Create: `src/adapters/http/rest-client.ts`
- Test: `src/adapters/http/rest-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface RestResponse { status: number; ok: boolean; body: unknown }
  interface RestInit { query?: Record<string, string | number | undefined>; headers?: Record<string, string> }
  interface RestClient { get(url, init?): Promise<RestResponse>; post(url, body, init?): Promise<RestResponse> }
  interface BuiltinCtx { http: RestClient }
  interface BuiltinTool { def: Tool; handle(ctx: BuiltinCtx, args: Record<string, unknown>): Promise<CallToolResult> }
  interface BuiltinProvider { id: string; toolPrefix: string; tools: BuiltinTool[] }
  function bearerRestClient(token: string, fetchImpl?): RestClient
  ```

- [ ] **Step 1: Write the failing test** (`src/adapters/http/rest-client.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { bearerRestClient } from "./rest-client.js";

const fakeFetch = (captured: { url?: string; init?: RequestInit }) =>
  (async (url: string, init?: RequestInit) => {
    captured.url = url; captured.init = init;
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;

describe("bearerRestClient", () => {
  it("attaches the bearer token and appends query params", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const c = bearerRestClient("tok", fakeFetch(cap));
    const res = await c.get("https://api.example.com/x", { query: { a: "1", b: 2 } });
    expect(cap.url).toBe("https://api.example.com/x?a=1&b=2");
    expect((cap.init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(res).toEqual({ status: 200, ok: true, body: { ok: 1 } });
  });

  it("post sends a JSON body with content-type and surfaces non-2xx bodies", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const errFetch = (async (url: string, init?: RequestInit) => {
      cap.url = url; cap.init = init;
      return new Response(JSON.stringify({ error: "bad" }), { status: 400 });
    }) as unknown as typeof fetch;
    const c = bearerRestClient("tok", errFetch);
    const res = await c.post("https://api.example.com/x", { name: "n" });
    expect(cap.init!.method).toBe("POST");
    expect(cap.init!.body).toBe(JSON.stringify({ name: "n" }));
    expect((cap.init!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(res).toEqual({ status: 400, ok: false, body: { error: "bad" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/adapters/http/rest-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/ports/builtin.ts`**

```ts
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface RestResponse { status: number; ok: boolean; body: unknown; }
export interface RestInit {
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
}
export interface RestClient {
  get(url: string, init?: RestInit): Promise<RestResponse>;
  post(url: string, body: unknown, init?: RestInit): Promise<RestResponse>;
}

/** Everything a builtin tool handler is given to do its work. */
export interface BuiltinCtx { http: RestClient; }

export interface BuiltinTool {
  /** MCP tool spec; `def.name` is UNPREFIXED (e.g. "search"). */
  def: Tool;
  handle(ctx: BuiltinCtx, args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface BuiltinProvider {
  /** Connection/upstream id whose OAuth token this provider uses (e.g. "atlassian"). */
  id: string;
  /** Tool-name prefix (e.g. "jira" → "jira__search"). */
  toolPrefix: string;
  tools: BuiltinTool[];
}
```

- [ ] **Step 4: Create `src/adapters/http/rest-client.ts`**

```ts
import type { RestClient, RestInit, RestResponse } from "../../ports/builtin.js";

function withQuery(url: string, query?: RestInit["query"]): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

async function parseBody(res: Response): Promise<unknown> {
  const raw = await res.text();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

/** A RestClient bound to one bearer token; parses JSON and never throws on non-2xx. */
export function bearerRestClient(token: string, fetchImpl: typeof fetch = fetch): RestClient {
  const call = async (
    method: "GET" | "POST", url: string, body?: unknown, init?: RestInit,
  ): Promise<RestResponse> => {
    const res = await fetchImpl(withQuery(url, init?.query), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, ok: res.ok, body: await parseBody(res) };
  };
  return {
    get: (url, init) => call("GET", url, undefined, init),
    post: (url, body, init) => call("POST", url, body, init),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/adapters/http/rest-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ports/builtin.ts src/adapters/http/rest-client.ts src/adapters/http/rest-client.test.ts
git commit -m "feat(builtin): add BuiltinProvider port and bearer RestClient"
```

---

### Task 3: `BuiltinToolsService`

**Files:**
- Create: `src/application/builtin-tools-service.ts`
- Test: `src/application/builtin-tools-service.test.ts`

**Interfaces:**
- Consumes: `BuiltinProvider`, `RestClient` (Task 2); `AccessTokenProvider.getFresh` (`application/access.ts`); `namespaceTool`/`parseTool` (`domain/tool-names.ts`); `User` (`ports/identity.ts`).
- Produces:
  ```ts
  class BuiltinToolsService {
    constructor(deps: { providers: BuiltinProvider[]; access: AccessTokenProvider; makeHttp: (token: string) => RestClient; baseUrl: string })
    listTools(user: User): Promise<Tool[]>
    callTool(user: User, name: string, args: Record<string, unknown>): Promise<CallToolResult | null> // null = not builtin, fall through to proxy
  }
  ```

- [ ] **Step 1: Write the failing test** (`src/application/builtin-tools-service.test.ts`)

```ts
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
  it("prompts reconnect when the token is unavailable", async () => {
    const s = svc(async () => null);
    const res = await s.callTool(user, "jira__search", {});
    expect(res!.isError).toBe(true);
    expect((res!.content[0] as any).text).toContain("https://p/connect/atlassian");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/application/builtin-tools-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/application/builtin-tools-service.ts`**

```ts
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { User } from "../ports/identity.js";
import type { BuiltinProvider, RestClient } from "../ports/builtin.js";
import type { AccessTokenProvider } from "./access.js";
import { namespaceTool, parseTool } from "../domain/tool-names.js";

export interface BuiltinDeps {
  providers: BuiltinProvider[];
  access: AccessTokenProvider;
  makeHttp: (token: string) => RestClient;
  baseUrl: string;
}

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }], isError: true,
});

/**
 * Lists and dispatches in-process builtin tools. Mirrors ProxyService, but the
 * tools are implemented locally instead of forwarded to a remote MCP. Gated on the
 * same `getFresh` connection check, so an unlinked/expired provider advertises
 * nothing and calling it prompts a reconnect.
 */
export class BuiltinToolsService {
  constructor(private readonly deps: BuiltinDeps) {}

  private byPrefix(prefix: string): BuiltinProvider | undefined {
    return this.deps.providers.find((p) => p.toolPrefix === prefix);
  }
  private connectUrl(id: string): string {
    return `${this.deps.baseUrl}/connect/${encodeURIComponent(id)}`;
  }

  async listTools(user: User): Promise<Tool[]> {
    const out: Tool[] = [];
    for (const p of this.deps.providers) {
      const fresh = await this.deps.access.getFresh(user.id, p.id);
      if (!fresh) continue;
      for (const t of p.tools) out.push({ ...t.def, name: namespaceTool(p.toolPrefix, t.def.name) });
    }
    return out;
  }

  /** Returns null when `name` is not a builtin tool, so the caller falls through to the proxy. */
  async callTool(user: User, name: string, args: Record<string, unknown>): Promise<CallToolResult | null> {
    const parsed = parseTool(name);
    if (!parsed) return null;
    const provider = this.byPrefix(parsed.prefix);
    if (!provider) return null;
    const tool = provider.tools.find((t) => t.def.name === parsed.name);
    if (!tool) return errorResult(`Unknown tool '${name}'.`);
    const fresh = await this.deps.access.getFresh(user.id, provider.id);
    if (!fresh) {
      return errorResult(
        `'${provider.id}' is not connected (or its authorization expired). ` +
          `Ask the user to open ${this.connectUrl(provider.id)} to connect.`,
      );
    }
    return tool.handle({ http: this.deps.makeHttp(fresh.accessToken) }, args);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/application/builtin-tools-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/builtin-tools-service.ts src/application/builtin-tools-service.test.ts
git commit -m "feat(builtin): BuiltinToolsService (list + dispatch, proxy fallthrough)"
```

---

### Task 4: Wire builtin tools into the MCP server + composition root

**Files:**
- Modify: `src/interface/mcp/portico-server.ts` (`PorticoServerDeps` + list/call merge)
- Modify: `src/interface/http/server.ts` (construct `BuiltinToolsService` with `providers: []`, pass into the mcp route deps)
- Test: `src/interface/mcp/portico-server.test.ts`

**Interfaces:**
- Consumes: `BuiltinToolsService` (Task 3), `bearerRestClient` (Task 2).
- Produces: `PorticoServerDeps.builtin: BuiltinToolsService`. `tools/list` order = `[portico__*, ...builtin, ...proxied]`; `tools/call` order = local → builtin (if non-null) → proxy.

- [ ] **Step 1: Write the failing test** (add to `src/interface/mcp/portico-server.test.ts`)

```ts
// A stub BuiltinToolsService: advertises jira__search, handles it, else returns null.
const builtinStub = {
  listTools: async () => [{ name: "jira__search", description: "d", inputSchema: { type: "object", properties: {} } }],
  callTool: async (_u: unknown, name: string) =>
    name === "jira__search" ? { content: [{ type: "text", text: "builtin-hit" }] } : null,
} as any;

it("lists builtin tools after portico__* and before proxied, and routes calls", async () => {
  const deps = makeDeps({ builtin: builtinStub }); // extend the test's existing deps factory
  const server = await buildPorticoServer(user, deps);
  const listed = await callList(server); // helper that invokes ListTools
  const names = listed.tools.map((t: any) => t.name);
  expect(names).toContain("jira__search");
  expect(names.indexOf("jira__search")).toBeGreaterThan(names.indexOf("portico__list_connections"));

  const res = await callTool(server, "jira__search", {});
  expect((res.content[0] as any).text).toBe("builtin-hit");
});
```
(Use the file's existing helpers/fakes for `makeDeps`, `callList`, `callTool`; if none exist, build a minimal `Server` request-invocation helper in the test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/interface/mcp/portico-server.test.ts`
Expected: FAIL — `builtin` not on deps; builtin tools absent from list.

- [ ] **Step 3: Edit `src/interface/mcp/portico-server.ts`**

Add the import and dep:
```ts
import type { BuiltinToolsService } from "../../application/builtin-tools-service.js";
```
```ts
export interface PorticoServerDeps {
  connections: ConnectionsService;
  proxy: ProxyService;
  builtin: BuiltinToolsService;
  artifacts: ArtifactsService;
}
```
In the `ListToolsRequestSchema` handler, merge builtin between locals and proxied:
```ts
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const builtin = await deps.builtin.listTools(user);
    const proxied = await deps.proxy.listTools(user);
    for (const e of proxied.errors) {
      console.warn(`upstream '${e.upstreamId}' listTools failed: ${e.message}`);
    }
    return { tools: [...locals.map((t) => t.def), ...builtin, ...proxied.tools] };
  });
```
In the `CallToolRequestSchema` handler, try builtin before proxy:
```ts
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const local = localByName.get(name);
    if (local) return local.handle(user, args ?? {});
    const builtinResult = await deps.builtin.callTool(user, name, args ?? {});
    if (builtinResult) return builtinResult;
    return deps.proxy.callTool(user, name, args ?? {});
  });
```

- [ ] **Step 4: Edit `src/interface/http/server.ts`**

Add imports near the other application/adapter imports:
```ts
import { BuiltinToolsService } from "../../application/builtin-tools-service.js";
import { bearerRestClient } from "../../adapters/http/rest-client.js";
```
After `const proxy = new ProxyService({ ... });`, construct the service (empty providers for now — Tasks 5 & 6 fill it):
```ts
  const builtin = new BuiltinToolsService({
    providers: [],
    access,
    makeHttp: (token) => bearerRestClient(token),
    baseUrl,
  });
```
Add `builtin` to the object passed to `registerMcpRoute` (the `McpRouteDeps`, which extends `PorticoServerDeps`). Find the `registerMcpRoute(app, { ... })` call and add `builtin,` alongside `connections, proxy, artifacts, tokens, baseUrl`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -- src/interface/mcp/portico-server.test.ts && npm run build:api`
Expected: PASS, and tsc builds clean. Fix any other test that constructs `PorticoServerDeps` without `builtin` by passing a stub `{ listTools: async () => [], callTool: async () => null }`.

- [ ] **Step 6: Commit**

```bash
git add src/interface/mcp/portico-server.ts src/interface/http/server.ts src/interface/mcp/portico-server.test.ts
git commit -m "feat(mcp): merge builtin tools between management and proxied tools"
```

---

### Task 5: Jira provider

**Files:**
- Create: `src/adapters/builtin/jira/index.ts`
- Test: `src/adapters/builtin/jira/index.test.ts`
- Modify: `src/interface/http/server.ts` (register the provider)

**Interfaces:**
- Consumes: `BuiltinProvider`, `BuiltinCtx` (Task 2).
- Produces: `export const jiraProvider: BuiltinProvider` (id `"atlassian"`, prefix `"jira"`, 5 tools).

- [ ] **Step 1: Write the failing test** (`src/adapters/builtin/jira/index.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { jiraProvider } from "./index.js";
import type { RestClient } from "../../../ports/builtin.js";

const SITE = [{ id: "cloud-1", url: "https://okadoc.atlassian.net", name: "okadoc" }];
function http(routes: Record<string, unknown>, calls: any[] = []): RestClient {
  const find = (url: string) => Object.entries(routes).find(([k]) => url.includes(k))?.[1];
  return {
    get: async (url, init) => { calls.push(["GET", url, init]); return { status: 200, ok: true, body: find(url) ?? null }; },
    post: async (url, body) => { calls.push(["POST", url, body]); return { status: 200, ok: true, body: find(url) ?? { key: "OK-1" } }; },
  };
}
const tool = (name: string) => jiraProvider.tools.find((t) => t.def.name === name)!;

describe("jiraProvider", () => {
  it("exposes the five tools with the jira prefix binding", () => {
    expect(jiraProvider.id).toBe("atlassian");
    expect(jiraProvider.toolPrefix).toBe("jira");
    expect(jiraProvider.tools.map((t) => t.def.name).sort())
      .toEqual(["add_comment", "create_issue", "get_issue", "list_projects", "search"]);
  });

  it("search resolves cloudId then calls /search with the JQL", async () => {
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE, "/search": { issues: [{ key: "AB-1" }] } }, calls);
    const res = await tool("search").handle({ http: c }, { jql: "project=AB", maxResults: 10 });
    expect(calls[0][1]).toContain("accessible-resources");
    const searchCall = calls.find((k) => String(k[1]).includes("/ex/jira/cloud-1/rest/api/3/search"));
    expect(searchCall[2].query).toEqual({ jql: "project=AB", maxResults: 10 });
    expect((res.content[0] as any).text).toContain("AB-1");
  });

  it("create_issue posts fields with an ADF description", async () => {
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE }, calls);
    await tool("create_issue").handle({ http: c }, { project: "AB", issueType: "Task", summary: "S", description: "hello" });
    const post = calls.find((k) => k[0] === "POST");
    expect(post[2].fields.project).toEqual({ key: "AB" });
    expect(post[2].fields.issuetype).toEqual({ name: "Task" });
    expect(post[2].fields.summary).toBe("S");
    expect(post[2].fields.description.type).toBe("doc");
  });

  it("surfaces the Jira error body instead of a generic message", async () => {
    const c: RestClient = {
      get: async (url) => url.includes("accessible-resources")
        ? { status: 200, ok: true, body: SITE }
        : { status: 400, ok: false, body: { errorMessages: ["Bad JQL"] } },
      post: async () => ({ status: 200, ok: true, body: null }),
    };
    const res = await tool("search").handle({ http: c }, { jql: "!!!" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("Bad JQL");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/adapters/builtin/jira/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/adapters/builtin/jira/index.ts`**

```ts
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BuiltinCtx, BuiltinProvider, BuiltinTool } from "../../../ports/builtin.js";

const ok = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});
const fail = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], isError: true,
});
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

/** Resolve the Jira Cloud REST base for the token's first accessible site. */
async function jiraBase(ctx: BuiltinCtx): Promise<{ base: string } | { error: CallToolResult }> {
  const res = await ctx.http.get("https://api.atlassian.com/oauth/token/accessible-resources");
  if (!res.ok) return { error: fail(`Could not resolve Atlassian site (HTTP ${res.status}): ${JSON.stringify(res.body)}`) };
  const sites = Array.isArray(res.body) ? (res.body as Array<{ id: string; url: string }>) : [];
  if (sites.length === 0) return { error: fail("This Atlassian token has no accessible Jira sites.") };
  return { base: `https://api.atlassian.com/ex/jira/${sites[0]!.id}/rest/api/3` };
}
const adf = (text: string) => ({
  type: "doc", version: 1,
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
});

const define = (def: Tool, run: (ctx: BuiltinCtx, base: string, a: Record<string, unknown>) => Promise<CallToolResult>): BuiltinTool => ({
  def,
  handle: async (ctx, a) => {
    const b = await jiraBase(ctx);
    if ("error" in b) return b.error;
    return run(ctx, b.base, a);
  },
});

export const jiraProvider: BuiltinProvider = {
  id: "atlassian",
  toolPrefix: "jira",
  tools: [
    define(
      { name: "search", description: "Search Jira issues with a JQL query.", inputSchema: {
        type: "object",
        properties: { jql: { type: "string", description: "JQL, e.g. project = AB AND status = Open" },
          maxResults: { type: "number", description: "default 25" } },
        required: ["jql"] } },
      async (ctx, base, a) => {
        const res = await ctx.http.get(`${base}/search`, { query: { jql: str(a.jql), maxResults: typeof a.maxResults === "number" ? a.maxResults : 25 } });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    define(
      { name: "get_issue", description: "Get a Jira issue by key.", inputSchema: {
        type: "object", properties: { key: { type: "string", description: "issue key, e.g. AB-123" } }, required: ["key"] } },
      async (ctx, base, a) => {
        const res = await ctx.http.get(`${base}/issue/${encodeURIComponent(str(a.key))}`);
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    define(
      { name: "create_issue", description: "Create a Jira issue.", inputSchema: {
        type: "object",
        properties: { project: { type: "string", description: "project key" }, issueType: { type: "string", description: "e.g. Task, Bug" },
          summary: { type: "string" }, description: { type: "string", description: "optional plain text" } },
        required: ["project", "issueType", "summary"] } },
      async (ctx, base, a) => {
        const fields: Record<string, unknown> = {
          project: { key: str(a.project) }, issuetype: { name: str(a.issueType) }, summary: str(a.summary),
        };
        if (typeof a.description === "string" && a.description) fields.description = adf(a.description);
        const res = await ctx.http.post(`${base}/issue`, { fields });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    define(
      { name: "add_comment", description: "Add a comment to a Jira issue.", inputSchema: {
        type: "object", properties: { key: { type: "string" }, body: { type: "string" } }, required: ["key", "body"] } },
      async (ctx, base, a) => {
        const res = await ctx.http.post(`${base}/issue/${encodeURIComponent(str(a.key))}/comment`, { body: adf(str(a.body)) });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    define(
      { name: "list_projects", description: "List Jira projects visible to you.", inputSchema: { type: "object", properties: {} } },
      async (ctx, base) => {
        const res = await ctx.http.get(`${base}/project/search`);
        return res.ok ? ok(res.body) : fail(res.body);
      }),
  ],
};
```

- [ ] **Step 4: Register in `src/interface/http/server.ts`**

Add `import { jiraProvider } from "../../adapters/builtin/jira/index.js";` and change the `BuiltinToolsService` construction to `providers: [jiraProvider],`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -- src/adapters/builtin/jira/index.test.ts && npm run build:api`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/builtin/jira src/interface/http/server.ts
git commit -m "feat(jira): builtin Jira tools over Jira Cloud REST"
```

---

### Task 6: Google Docs provider

**Files:**
- Create: `src/adapters/builtin/google-docs/index.ts`
- Test: `src/adapters/builtin/google-docs/index.test.ts`
- Modify: `src/interface/http/server.ts` (register the provider)

**Interfaces:**
- Consumes: `BuiltinProvider`, `BuiltinCtx` (Task 2).
- Produces: `export const googleDocsProvider: BuiltinProvider` (id `"google-docs"`, prefix `"gdocs"`, 4 tools).

- [ ] **Step 1: Write the failing test** (`src/adapters/builtin/google-docs/index.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { googleDocsProvider } from "./index.js";
import type { RestClient } from "../../../ports/builtin.js";

function http(body: unknown, calls: any[] = []): RestClient {
  return {
    get: async (url, init) => { calls.push(["GET", url, init]); return { status: 200, ok: true, body }; },
    post: async (url, b) => { calls.push(["POST", url, b]); return { status: 200, ok: true, body }; },
  };
}
const tool = (name: string) => googleDocsProvider.tools.find((t) => t.def.name === name)!;

describe("googleDocsProvider", () => {
  it("binds to the google-docs connection with the gdocs prefix", () => {
    expect(googleDocsProvider.id).toBe("google-docs");
    expect(googleDocsProvider.toolPrefix).toBe("gdocs");
    expect(googleDocsProvider.tools.map((t) => t.def.name).sort())
      .toEqual(["append_text", "create_document", "get_document", "list_documents"]);
  });

  it("create_document posts a title to the Docs API", async () => {
    const calls: any[] = [];
    await tool("create_document").handle({ http: http({ documentId: "d1" }, calls) }, { title: "Notes" });
    expect(calls[0][1]).toBe("https://docs.googleapis.com/v1/documents");
    expect(calls[0][2]).toEqual({ title: "Notes" });
  });

  it("append_text sends a batchUpdate insertText at end of segment", async () => {
    const calls: any[] = [];
    await tool("append_text").handle({ http: http({}, calls) }, { documentId: "d1", text: "hi" });
    expect(calls[0][1]).toBe("https://docs.googleapis.com/v1/documents/d1:batchUpdate");
    expect(calls[0][2].requests[0].insertText).toEqual({ endOfSegmentLocation: {}, text: "hi" });
  });

  it("list_documents queries Drive for Google Doc files", async () => {
    const calls: any[] = [];
    await tool("list_documents").handle({ http: http({ files: [] }, calls) }, {});
    expect(calls[0][1]).toBe("https://www.googleapis.com/drive/v3/files");
    expect(calls[0][2].query.q).toBe("mimeType='application/vnd.google-apps.document'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/adapters/builtin/google-docs/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/adapters/builtin/google-docs/index.ts`**

```ts
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BuiltinCtx, BuiltinProvider, BuiltinTool } from "../../../ports/builtin.js";

const ok = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});
const fail = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], isError: true,
});
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const DOCS = "https://docs.googleapis.com/v1/documents";

const t = (def: Tool, handle: BuiltinTool["handle"]): BuiltinTool => ({ def, handle });

export const googleDocsProvider: BuiltinProvider = {
  id: "google-docs",
  toolPrefix: "gdocs",
  tools: [
    t({ name: "create_document", description: "Create a new Google Doc.", inputSchema: {
        type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
      async (ctx, a) => {
        const res = await ctx.http.post(DOCS, { title: str(a.title) });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    t({ name: "get_document", description: "Fetch a Google Doc's content by id.", inputSchema: {
        type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"] } },
      async (ctx, a) => {
        const res = await ctx.http.get(`${DOCS}/${encodeURIComponent(str(a.documentId))}`);
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    t({ name: "append_text", description: "Append text to the end of a Google Doc.", inputSchema: {
        type: "object", properties: { documentId: { type: "string" }, text: { type: "string" } },
        required: ["documentId", "text"] } },
      async (ctx, a) => {
        const res = await ctx.http.post(`${DOCS}/${encodeURIComponent(str(a.documentId))}:batchUpdate`, {
          requests: [{ insertText: { endOfSegmentLocation: {}, text: str(a.text) } }],
        });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    t({ name: "list_documents", description: "List Google Docs this app can see.", inputSchema: {
        type: "object", properties: { pageSize: { type: "number", description: "default 25" } } } },
      async (ctx, a) => {
        const res = await ctx.http.get("https://www.googleapis.com/drive/v3/files", {
          query: {
            q: "mimeType='application/vnd.google-apps.document'",
            pageSize: typeof a.pageSize === "number" ? a.pageSize : 25,
            fields: "files(id,name,modifiedTime)",
          },
        });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
  ],
};
```

- [ ] **Step 4: Register in `src/interface/http/server.ts`**

Add `import { googleDocsProvider } from "../../adapters/builtin/google-docs/index.js";` and change the construction to `providers: [jiraProvider, googleDocsProvider],`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -- src/adapters/builtin/google-docs/index.test.ts && npm run build:api`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/builtin/google-docs src/interface/http/server.ts
git commit -m "feat(gdocs): builtin Google Docs tools over Docs + Drive REST"
```

---

### Task 7: Config, docs, and deploy checklist

**Files:**
- Modify: `.env.example` (Google Docs upstream keys)
- Modify: `README.md` (upstream table: google-docs; note Jira is now builtin)
- Create: `docs/providers-builtin.md` (Google Cloud + Vault + smoke-test checklist)

**Interfaces:** none (config + docs only).

- [ ] **Step 1: Add to `.env.example`** (after the Google Drive block)

```bash
# Google Docs — builtin tools (Docs + Drive REST). A SECOND Google OAuth client,
# separate from the login one. Enable the Google Docs API and Drive API.
#   -> Authorized redirect URI: http://localhost:8080/connect/google-docs/callback
#   Scopes: .../auth/documents  .../auth/drive.file
PORTICO_UPSTREAM_GOOGLE_DOCS_CLIENT_ID=
PORTICO_UPSTREAM_GOOGLE_DOCS_CLIENT_SECRET=
```

- [ ] **Step 2: Update `README.md`**

In the upstream/config table, add a `google-docs` row (its `_CLIENT_ID`/`_SECRET`), and add a line noting Jira tools (`jira__*`) are served in-process from the existing `atlassian` connection (no separate config), while Confluence still proxies the hosted Atlassian MCP.

- [ ] **Step 3: Create `docs/providers-builtin.md`** with the operator checklist

```markdown
# Builtin providers — setup

## Google Docs (new OAuth client)
1. Google Cloud console → enable **Google Docs API** + **Google Drive API**.
2. Credentials → Create OAuth client ID → Web application (`portico google-docs`).
3. Redirect URIs: `https://portico.int.okadoc.net/connect/google-docs/callback`
   and `http://localhost:8080/connect/google-docs/callback`.
4. Consent screen (Internal): add scopes `.../auth/documents`, `.../auth/drive.file`.
5. Put the client id/secret in `PORTICO_UPSTREAM_GOOGLE_DOCS_CLIENT_ID/_SECRET`
   (locally in `.env`; in prod in the flux-infra Vault path
   `infrastructure/admin-v2/portico/vaultstaticsecret.yaml`).

## Jira (no new setup)
Uses the existing `atlassian` 3LO connection and its granted scopes
(`read:jira-work`, `write:jira-work`, `read:jira-user`, `read:me`). Nothing to add.

## Smoke test (manual, after deploy)
- Connect Google Docs from the portal, then via an MCP client:
  `gdocs__create_document {title}` → `gdocs__append_text {documentId,text}` → `gdocs__get_document {documentId}`.
- With Atlassian connected: `jira__list_projects` → `jira__search {jql}` → `jira__get_issue {key}`.
- Confirm a bad `jira__search` JQL returns the real Jira error text (not the hosted-MCP generic message).
```

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md docs/providers-builtin.md
git commit -m "docs(builtin): google-docs config, README, operator checklist"
```

- [ ] **Step 5: Final verification**

Run: `npm test && npm run build:api`
Expected: full suite green, clean tsc build. Then update the flux-infra Vault secret with the two Google Docs keys as a separate deploy PR (out of this repo).

---

## Self-Review

**Spec coverage:** builtin seam (T4) · reusable getFresh hook (T3) · BuiltinProvider port + adapters (T2,T5,T6) · BuiltinToolsService mirroring ProxyService (T3) · registry `kind` + `isConfigured` fix + google-docs seed (T1) · Jira REST reuse of atlassian conn (T5) · Google Docs new client + scopes (T6) · config/deploy + Google Cloud steps (T7) · hermetic tests (every task) · traps (multi-site first-wins, offline/consent for refresh, drive.file listing, duplicate Jira tools) noted in spec and README. All covered.

**Placeholder scan:** every code + test step has literal code; no TBD/TODO.

**Type consistency:** `getFresh → Connection|null`, `callTool → CallToolResult|null` (fallthrough), `BuiltinProvider{id,toolPrefix,tools}`, `RestClient.get/post`, `bearerRestClient(token,fetchImpl?)`, provider ids (`atlassian`/`google-docs`) and prefixes (`jira`/`gdocs`) are used identically across T2–T6.
