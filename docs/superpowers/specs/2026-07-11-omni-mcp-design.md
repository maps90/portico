# omni-mcp — Unified MCP Gateway + Artifact Host for Okadoc

## Context

**Jean** (`~/Work/projects/jean`) is a Slack-native Claude Code runtime — an AI
teammate that runs `claude-agent-sdk` sessions and speaks through an in-process
MCP server. To be useful it needs tools from many SaaS services (Jira, Google
Drive, GitHub, Confluence…), each of which has its own OAuth. Wiring every
service's auth into Jean directly is brittle and doesn't scale across users.

**omni-mcp** solves this as a single standalone service with two capabilities on
a shared identity core:

1. **Unified MCP proxy gateway** — a user logs into the "omni channel" once via
   Okadoc's Microsoft Entra tenant and gets **one bearer token**. Jean connects
   to omni-mcp with that token and sees the aggregated, namespaced tools of every
   upstream MCP server that user has linked. omni-mcp holds each user's per-service
   OAuth tokens server-side (encrypted) and proxies calls through.
2. **HTML artifact host** — Jean generates rich HTML (reports/dashboards) that
   Slack can't render inline, calls `omni__publish_html`, and gets back a
   login-gated URL to post in the thread.

Target deployment: **Okadoc on Azure** (Entra identity, Azure Blob Storage, Azure
Database for PostgreSQL, Key Vault, container on AKS/Container Apps).

This plan file stands in for the brainstorming spec doc (plan mode restricts edits
to this file). All design decisions below were confirmed with the user.

## Locked decisions

| Area | Decision |
|------|----------|
| Stack | TypeScript, official `@modelcontextprotocol/sdk` (server + client), Streamable HTTP transport |
| Auth approach | **B** — lightweight token-vault gateway: opaque bearer token per OIDC user (not a full OAuth AS); `.well-known` metadata deferrable as an upgrade path |
| Identity | Pluggable OIDC, **Microsoft Entra single-tenant = Okadoc only**; reject users outside the tenant. Google dropped at launch |
| Upstream model | **Proxy existing remote MCP servers** (meta-MCP), namespaced tool prefixes |
| Upstream vault | Per-`(user, upstream)` OAuth tokens, AES-256-GCM encrypted, in Postgres |
| Store | **Azure Database for PostgreSQL** for metadata/tokens; **Azure Blob Storage** for artifact bytes |
| Artifact view authz | **OIDC-session-gated** (signed browser cookie); default visibility = any authenticated omni user; `private` = owner-only; never anonymous |
| MVP proxy scope | **Tools only** (resources/prompts later) |
| Launch upstreams | Jira (Atlassian), Google Drive, GitHub, Confluence (+ Azure DevOps candidate) — registry-driven |
| Architecture | Ports & adapters, mirroring Jean's discipline |

## Architecture

Two auth planes over one identity core:

- **Plane 1 — Identity.** `/login` → Entra OIDC → verify `id_token`, enforce Okadoc
  tenant → upsert `users(issuer, subject)` → mint opaque bearer token (stored
  hashed) shown once for Jean's config, **and** set a signed session cookie for
  browser artifact viewing.
- **Plane 2 — Connections.** Per user, per service OAuth 2.1 auth-code + PKCE
  against each upstream; tokens encrypted in the vault; auto-refresh.

### Component map (domain depends only on ports; adapters wire concretes)

| Module | Responsibility |
|--------|----------------|
| `config.ts` | `OMNI_*` env → typed settings |
| `ports.ts` | Interfaces: `UserStore`, `TokenStore`, `ConnectionVault`, `ArtifactStore`, `OidcVerifier`, `Crypto` |
| `identity/oidc.ts` | Entra OIDC verify + tenant enforcement (pluggable provider) |
| `identity/session.ts` | Bearer-token mint/validate + signed session cookies |
| `registry/registry.ts` | Declarative upstream registry `{ id, displayName, mcpUrl, transport, toolPrefix, oauth{authorizationUrl,tokenUrl,scopes,clientId,clientSecret|dynamicRegistration}, discovery? }` |
| `upstream/oauth.ts` | Per-upstream OAuth 2.1 + PKCE flow, token exchange & refresh |
| `upstream/client.ts` | `UpstreamClient` — MCP SDK `Client` to one upstream, user token injected; cached per `(user,upstream)`, idle-evicted |
| `proxy/aggregator.ts` | `tools/list` fan-out → prefix names → merge + omni tools; skip-and-annotate unreachable upstreams |
| `proxy/router.ts` | `tools/call` → strip prefix → route to owning `UpstreamClient` |
| `tools/omni.ts` | `omni__list_connections`, `omni__connect`, `omni__disconnect`, `omni__publish_html`, `omni__list_artifacts`, `omni__revoke_artifact` |
| `artifacts/service.ts` | Publish → Blob put + metadata row; view authz check; revoke |
| `db/postgres.ts` | Postgres adapter (pg) for all data ports |
| `store/blob.ts` | `ArtifactStore` adapter over Azure Blob Storage |
| `crypto/aesgcm.ts` | AES-256-GCM encrypt/decrypt (key from Key Vault/env) |
| `http/server.ts` | Composition root: HTTP routes + MCP endpoint + wiring |
| `health.ts` | `/healthz`, `/readyz` |

### HTTP surface
- `GET /login`, `GET /auth/entra/callback` — identity login (mints token + cookie)
- `GET /connect/:upstreamId`, `GET /connect/:upstreamId/callback` — upstream OAuth linking (bearer/session required)
- `POST /mcp` (+ `GET` for SSE stream) — Streamable HTTP MCP endpoint, bearer-protected
- `GET /a/:id` — artifact view; session-cookie-gated → authz → stream bytes from Blob **server-side** (bucket stays private) with strict CSP + `text/html`
- `GET /healthz`, `GET /readyz`

### Postgres schema
- `users(id, issuer, subject, email, created_at, UNIQUE(issuer, subject))`
- `tokens(id, user_id, token_hash, name, created_at, last_used_at, revoked_at)`
- `connections(user_id, upstream_id, access_token_enc, refresh_token_enc, expires_at, scopes, status, connected_at, updated_at, PRIMARY KEY(user_id, upstream_id))`
- `oauth_state(state, user_id, upstream_id, pkce_verifier, redirect, created_at)`
- `artifacts(id, owner_user_id, title, storage_ref, content_hash, visibility, created_at, expires_at, revoked_at)`

### Error handling
- Missing/invalid/revoked bearer → `401`.
- Upstream `401` → refresh once → else mark connection `expired` + return tool
  error whose content carries a connect URL (agent surfaces "click to connect").
- Upstream timeout/unreachable → degrade: drop from `tools/list`, annotate; don't fail the whole list.
- Artifact view without valid session → redirect to `/login`; unauthorized user → `403`.

## Implementation milestones

Build in dependency order; each milestone is independently testable against fakes.

1. **Scaffold** — TS project (tsconfig, package.json, esbuild/tsx, vitest, Dockerfile), `config.ts`, `ports.ts`, `health.ts`, composition-root skeleton.
2. **Identity core** — Entra OIDC verify + Okadoc-tenant enforcement; bearer mint/validate (hashed); signed session cookies; `users`/`tokens` tables; `/login` + callback. Fakes for `OidcVerifier`.
3. **MCP server endpoint** — `POST /mcp` Streamable HTTP with bearer middleware; expose only `omni__*` management tools first (no upstreams yet). Prove a Jean-style client can connect + list.
4. **Upstream registry + OAuth linking** — registry module; `upstream/oauth.ts` PKCE flow; `connections` + `oauth_state` tables; AES-GCM vault; `/connect/:id` + callback; `omni__connect/list/disconnect`.
5. **Proxy engine** — `UpstreamClient`, `aggregator`, `router`; wire real `tools/list` fan-out + `tools/call` routing with namespacing; refresh + expired handling.
6. **Artifact host** — `store/blob.ts` (Azure Blob), `artifacts/service.ts`, `omni__publish_html/list/revoke`, `/a/:id` session-gated streaming + CSP.
7. **Azure deployment** — Dockerfile + AKS/Container Apps manifest, Key Vault-sourced secrets, Azure DB for PostgreSQL, Blob container; env docs.
8. **Jean integration** — document/attach omni-mcp as an external MCP server in Jean's `ClaudeSDKClient` options with a user bearer token (Jean-side wiring is a follow-up; omni-mcp exposes the standard Streamable HTTP endpoint it already consumes).

## Key reuse / references
- **Jean's ports-&-adapters pattern** (`~/Work/projects/jean/ARCHITECTURE.md`,
  `src/jean/ports.py`, `db/memory.py`+`db/postgres.py` proven against one behavioral
  suite) — mirror the domain/adapter split and the in-memory-fake test strategy.
- **Jean's MCP tool shape** (`src/jean/slack/mcp.py`) — model `omni__*` tools on it.
- **Jean's config discipline** (`config.py`, `OMNI_*` mirroring `JEAN_*`).
- **`@modelcontextprotocol/sdk`** — reuse its `Server` (Streamable HTTP) and
  `Client` classes rather than hand-rolling MCP framing.

## Env / config (`OMNI_*`)
`OMNI_DATABASE_URL`, `OMNI_BASE_URL`, `OMNI_ENCRYPTION_KEY`, `OMNI_SESSION_SECRET`,
`OMNI_ENTRA_TENANT_ID`, `OMNI_ENTRA_CLIENT_ID`, `OMNI_ENTRA_CLIENT_SECRET`,
`OMNI_ARTIFACT_BLOB_ACCOUNT`/`OMNI_ARTIFACT_CONTAINER` (+ Azure creds/managed
identity), plus per-upstream client creds. Secrets sourced from Key Vault in prod.

## Verification

- **Unit (vitest, fakes, no infra):** registry parse; tool name prefix/deprefix
  round-trip; router selects correct upstream; aggregator merge + skip-unreachable;
  token-refresh policy; artifact visibility authz decisions; tenant enforcement rejects non-Okadoc `id_token`.
- **Integration:** fake upstream MCP server + fake Entra → login → mint token →
  `/connect` a fake upstream → connect a Jean-style MCP `Client` to `/mcp` → assert
  a proxied tool appears namespaced and a `tools/call` round-trips. Postgres adapter
  test gated on a test DB URL (Jean's pattern).
- **End-to-end (manual, Azure staging):** Entra login in browser → paste token into
  a real MCP client → connect real Jira/Drive → call a tool → `omni__publish_html`
  → open `/a/:id` in an authenticated browser (and confirm a logged-out browser is
  redirected to `/login`).
- Run before claiming done: `npm test` green + the login→connect→proxy→publish e2e path exercised.
