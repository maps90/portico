# portico

A unified **MCP gateway** + **HTML artifact host**. One token, every service.

- **Gateway** — sign in with Google, link Jira/Confluence, Google Drive, GitHub…
  from the portal, and get **one bearer token**. Point Jean (or any MCP client) at
  portico with that token and it sees the aggregated, namespaced tools of every
  service you've linked. portico holds each user's per-service OAuth tokens
  server-side, AES-256-GCM encrypted, and proxies calls through — linking a new
  service does not change your token.
- **Portal** — a React page at `/`: your token, and a Connect/Disconnect button per
  service.
- **Visual host** — publish rich HTML (reports, dashboards, charts, diagrams) and get back
  a login-gated URL at `/visual/<id>`. **JavaScript runs**: ECharts and Mermaid are vendored
  same-origin under `/vendor/`. The page is framed with `sandbox="allow-scripts"` on an
  opaque origin and a CSP with `connect-src 'none'` and no external origin, so agent-authored
  script can draw a chart but cannot reach the network, read a session cookie, or escape its
  frame. Bytes live on disk locally, in Azure Blob Storage in production.

## Quick start

```bash
make setup     # install deps, write .env with freshly generated secrets
#              then put your Google + Atlassian OAuth credentials in .env
make dev       # Postgres in docker + API on :8080 + portal on :5173
```

Open <http://localhost:5173>, sign in with Google, copy your token, click **Connect**
on Jira. `make` on its own lists every target.

### What you need in `.env`

| Variable | Where it comes from |
|---|---|
| `PORTICO_GOOGLE_CLIENT_ID` / `_SECRET` | Google Cloud Console → Credentials → OAuth client ID (Web application). Redirect URI: `http://localhost:8080/auth/google/callback` |
| `PORTICO_ALLOWED_DOMAINS` | Workspace domains allowed to sign in (e.g. `okadoc.com`). **Empty means any Google account** — fine on localhost, set it in production. |
| `PORTICO_UPSTREAM_ATLASSIAN_CLIENT_ID` / `_SECRET` | developer.atlassian.com → OAuth 2.0 (3LO). Callback: `http://localhost:8080/connect/atlassian/callback`. **Enable on the app's Permissions tab every scope Portico requests** — Atlassian grants only what the app is configured for, and does so silently. |
| `PORTICO_UPSTREAM_ATLASSIAN_SCOPES` | Optional override (space/comma separated). Atlassian documents the scope set its MCP server needs nowhere, so this exists to let you iterate without a redeploy. |

`make setup` generates `PORTICO_ENCRYPTION_KEY` and `PORTICO_SESSION_SECRET` for you.
Other upstreams (GitHub, Google Drive) follow the same `PORTICO_UPSTREAM_<ID>_*`
pattern and simply show as *Not configured* in the portal until you fill them in.

## Commands

```bash
make dev        # hot-reload API + portal
make run        # build, then serve both from :8080 (production-shaped)
make test       # full suite — no database, no cloud, no credentials
make typecheck  # API + portal
make check      # typecheck + test
make down       # stop Postgres (make db-reset wipes it)
```

Requires Node >= 20, Docker (for Postgres), and the OAuth clients above.

## How it fits together

Two separate auth planes, which is the whole trick:

1. **Identity** — Google OIDC decides *who you are*, and mints one opaque bearer
   token (stored hashed) plus a browser session cookie.
2. **Connections** — per user, per service, an OAuth 2.1 auth-code + PKCE flow
   against the vendor. Those tokens are encrypted in the vault and refreshed
   server-side. Your portico token never changes, and MCP clients never see a
   vendor credential.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the layering,
[`docs/jean-integration.md`](docs/jean-integration.md) for wiring it into Jean, and
[`deploy/DEPLOY.md`](deploy/DEPLOY.md) for the Azure deployment.

## Status

Feature-complete. The default suite (118 tests) runs entirely on in-memory adapters — no
database, no cloud, no credentials. `make test-e2e` additionally drives a real browser to
verify the visual sandbox holds; it is the only test that needs one.
