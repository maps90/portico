# Builtin tools — Jira and Google Docs implemented in-process

**Status:** approved, not yet implemented
**Date:** 2026-07-25

## Problem

Portico is a pure MCP **proxy**: a user links a service, and portico forwards
`tools/list` / `tools/call` to that vendor's **hosted MCP server**
(`src/application/proxy-service.ts`, `src/adapters/registry/default-registry.ts`).
Two things this model cannot deliver are exactly what we need:

1. **Jira is broken in practice.** The `atlassian` upstream proxies
   `https://mcp.atlassian.com/v1/sse`. Its tools fail with the generic, un-actionable
   *"We are having trouble completing this action. Please try again shortly."* — the
   same class of failure the registry comment already documents for the `read:me`
   scope. The hosted MCP names neither the tool nor the cause, so every round of
   diagnosis is a guess. We do not control it and cannot fix it.

2. **Google Docs cannot be a proxied upstream at all.** Google ships no public MCP
   server — the `google-drive` seed already carries `defaultMcpUrl: ""` and therefore
   OAuth-links but exposes **zero tools**. Adding Google Docs the proxy way is
   impossible without standing up a bridge.

The reference implementation (`github.com/barockok/workbench`) solves both by
**implementing each integration in-repo** (`packages/plugins/atlassian-jira`,
`packages/plugins/google-docs`) against the vendor REST API, using the per-user OAuth
token it already stores. We will adopt the same shape inside portico.

## Goal

A linked user's MCP client sees working, namespaced tools that portico implements
itself:

- `jira__search`, `jira__get_issue`, `jira__create_issue`, `jira__add_comment`,
  `jira__list_projects` — calling the Jira Cloud REST API directly, reusing the
  **existing `atlassian` OAuth connection** (no new OAuth app, no Atlassian config
  change). This bypasses `mcp.atlassian.com` and its generic error.
- `gdocs__create_document`, `gdocs__get_document`, `gdocs__append_text`,
  `gdocs__list_documents` — calling the Google Docs + Drive REST APIs, behind a **new
  `google-docs` connectable service** with its own Google OAuth client.

Existing proxied upstreams (Confluence via `atlassian`, GitHub) keep working unchanged.

## Non-goals

- **Not removing the proxy.** Builtin tools sit *alongside* the proxy, not in place of
  it. Confluence keeps flowing through the hosted Atlassian MCP for now.
- **Not a general plugin marketplace.** Workbench has a plugin SDK, per-plugin
  packages, and a manifest loader. We add exactly two providers behind one internal
  port — no dynamic loading, no package boundary. YAGNI.
- **Not the full Jira/Docs surface.** Five Jira tools and four Docs tools this pass.
  Transitions, issue update, replace-text, attachments, richer Drive queries are
  later work.
- **Not touching identity.** Google *login* (`src/adapters/oidc/google.ts`) is
  unrelated to the new Google *Docs* OAuth client; they stay separate, as the
  `google-drive` seed already is.

## Design

### The seam

`buildPorticoServer` (`src/interface/mcp/portico-server.ts`) already composes tools
from two sources and dispatches in order:

```
tools/list  = [ portico__* management tools , …proxied upstream tools ]
tools/call  = portico__* local handler  ELSE  proxy.callTool(...)
```

Builtin tools become a **third source, inserted between the two**:

```
tools/list  = [ portico__* , …builtin tools , …proxied tools ]
tools/call  = portico__*  ELSE  builtin (by prefix)  ELSE  proxy.callTool
```

The proxy path is untouched. Prefix routing already exists (`domain/tool-names.ts`
`namespaceTool`/`parseTool`); a builtin provider owns a `toolPrefix` exactly like a
proxied upstream, so a name like `jira__search` is unambiguous.

### The reusable hook

`AccessTokenProvider.getFresh(userId, upstreamId)` (`src/application/access.ts`,
consumed by `ProxyService`) returns a **fresh, auto-refreshed** access token for a
`(user, upstream)` pair, or `null` when not linked / expired. Builtin handlers use
this and nothing else for auth — refresh, expiry, and the "reconnect" prompt are
already solved and stay in one place.

### New abstraction (one internal port, two adapters)

Following the existing hexagonal layering (`ARCHITECTURE.md`):

- **`ports/builtin.ts`** — the contract:
  ```ts
  interface BuiltinTool {
    def: Tool;                                   // MCP tool spec (unprefixed name)
    handle(ctx: BuiltinCtx, args: Record<string, unknown>): Promise<CallToolResult>;
  }
  interface BuiltinProvider {
    id: string;            // connection/upstream id whose token it uses, e.g. "atlassian"
    toolPrefix: string;    // "jira", "gdocs"
    tools: BuiltinTool[];
  }
  interface BuiltinCtx {
    getToken(): Promise<string>;                 // fresh token for this provider's upstream id
    http: RestClient;                            // thin fetch wrapper (json, throws typed errors)
  }
  ```
  `id` is deliberately separate from `toolPrefix`: the `jira` provider’s `id` is
  `atlassian` because it reuses that connection’s token, while its prefix is `jira`.

- **`adapters/builtin/jira/`** and **`adapters/builtin/google-docs/`** — the two
  providers: a small file per tool plus an `index.ts` that assembles the
  `BuiltinProvider`. Pure functions over `(ctx, args)`; all I/O goes through
  `ctx.http`, so they unit-test against a fake with no network.

- **`adapters/http/rest-client.ts`** — the `RestClient` port impl: `get/post` over
  `fetch`, sets `Authorization: Bearer`, parses JSON, and maps non-2xx into a
  `CallToolResult` `isError` with the vendor’s message surfaced (the opposite of the
  hosted MCP’s opacity — we show the real 400/403 body).

- **`application/builtin-tools-service.ts`** — mirrors `ProxyService`: for a user,
  `listTools` returns the defs of every builtin provider whose connection is active in
  the vault (namespaced via `toolPrefix`), skipping unlinked ones; `callTool` parses
  the prefix, builds a `BuiltinCtx` bound to that provider’s `getFresh` token, and
  dispatches. Registered in the composition root and passed to `buildPorticoServer`.

### Registry change

`Seed`/`UpstreamEntry` (`domain/upstream.ts`, `adapters/registry/default-registry.ts`)
gain `kind: "proxied" | "builtin"` (default `"proxied"`).

- `atlassian` **stays** a proxied upstream (Confluence still needs the hosted MCP), but
  its Jira surface now also comes from the `jira` builtin provider bound to the
  `atlassian` connection. Both list; there is no collision because prefixes differ
  (`atlassian__*` proxied vs `jira__*` builtin). *(If the hosted Atlassian MCP’s
  `atlassian__*jira*` tools remain confusingly duplicative, hiding them is a config
  follow-up, not part of this change.)*
- **new `google-docs` seed**, `kind: "builtin"`, Google auth/token URLs, scopes
  `["https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file"]`, `authorizeParams { access_type:
  "offline", prompt: "consent" }`. It links through the **existing** connect flow
  (`connect-routes.ts`) — the OAuth code path does not care whether the upstream is
  proxied or builtin.

### Jira provider details

The `atlassian` 3LO token has audience `api.atlassian.com` and scopes
`read:jira-work`, `write:jira-work`, `read:jira-user`, `read:me` — enough for all five
tools. Resolve the site once per call context:

```
GET https://api.atlassian.com/oauth/token/accessible-resources   → [{ id: cloudId, url, name }]
```

then hit `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…`:

| Tool | REST call |
|---|---|
| `jira__search` | `GET /search?jql=&maxResults=` |
| `jira__get_issue` | `GET /issue/{key}` |
| `jira__create_issue` | `POST /issue` (project key, issuetype, summary, description) |
| `jira__add_comment` | `POST /issue/{key}/comment` |
| `jira__list_projects` | `GET /project/search` |

When `accessible-resources` returns more than one site, take the first and note it in
the result (a `site` argument to pin it is a later refinement). A 4xx surfaces the Jira
error body verbatim — the whole point of leaving the hosted MCP.

### Google Docs provider details

New `google-docs` connection, own OAuth client:

| Tool | REST call |
|---|---|
| `gdocs__create_document` | `POST https://docs.googleapis.com/v1/documents` (title) |
| `gdocs__get_document` | `GET  https://docs.googleapis.com/v1/documents/{id}` |
| `gdocs__append_text` | `POST …/documents/{id}:batchUpdate` (insertText at end) |
| `gdocs__list_documents` | `GET https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.document'` |

`drive.file` scopes listing/creation to docs the app created or the user opened with it
— the least-privilege choice workbench uses; full-drive access is intentionally not
requested.

## Configuration & deploy

- **Env:** `PORTICO_UPSTREAM_GOOGLE_DOCS_CLIENT_ID` / `_SECRET`. Add to
  `.env.example` with the redirect `…/connect/google-docs/callback`, and to the
  flux-infra Vault secret (`infrastructure/admin-v2/portico/vaultstaticsecret.yaml`).
  Atlassian keys unchanged.
- **Google Cloud:** enable the **Google Docs API** and **Drive API**; create a
  `google-docs` OAuth client (Web application), redirect
  `https://portico.int.okadoc.net/connect/google-docs/callback` and the localhost
  equivalent; add the two scopes to the consent screen. Internal-type app → no
  verification.
- **Atlassian:** nothing. The fix reuses the current app and its granted scopes.

## Testing

- Each tool is a pure function over `(ctx, args)`; unit tests inject a fake
  `RestClient` returning canned JSON and assert the request shape and the
  `CallToolResult`. No network, no creds — `make test` stays hermetic.
- `BuiltinToolsService` tested with in-memory vault + fake `getFresh`: unlinked
  provider omitted from `listTools`; expired token yields a reconnect prompt on
  `callTool`; prefix routing dispatches to the right tool.
- `portico-server` test extended: `tools/list` includes builtin tools ordered after
  `portico__*` and before proxied; `tools/call` routes `jira__*` to builtin, unknown
  to proxy.
- One live-smoke checklist in the deploy doc (create a doc, append, read back; search a
  Jira project) — manual, not in CI.

## Risks & traps

- **Duplicate Jira tools.** The hosted Atlassian MCP still advertises its own Jira
  tools under `atlassian__*`. Users see both until we optionally suppress the proxied
  ones — acceptable for this pass; call it out in the connect UI copy.
- **Multi-site Atlassian.** `accessible-resources` can return several sites; first-wins
  may surprise a user on two Jira instances. Documented; `site` arg is follow-up.
- **Google refresh tokens.** Without `access_type=offline` + `prompt=consent` Google
  returns no refresh token and the connection dies in an hour. The seed sets both.
- **Scope drift.** `drive.file` cannot list documents the app never touched; a user
  expecting to see their whole Drive will not. Intended; `drive.readonly` is a
  deliberate escalation we are not making.
