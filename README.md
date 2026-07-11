# portico

A unified **MCP gateway** + **HTML artifact host** for Okadoc.

- **Gateway** — log into the Portico channel once via Microsoft Entra (Okadoc
  tenant) and get **one bearer token**. Point Jean (or any MCP client) at
  portico with that token and it sees the aggregated, namespaced tools of every
  upstream MCP server you've linked (Jira, Google Drive, GitHub, Confluence, …).
  portico holds each user's per-service OAuth tokens server-side, encrypted, and
  proxies calls through.
- **Artifact host** — publish rich HTML (reports/dashboards) and get back a
  login-gated URL. Bytes live in Azure Blob Storage; only authenticated Portico
  users can view.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the design,
[`docs/jean-integration.md`](docs/jean-integration.md) for wiring it into Jean,
[`deploy/DEPLOY.md`](deploy/DEPLOY.md) for Azure deployment, and
[`docs/superpowers/specs/2026-07-11-portico-design.md`](docs/superpowers/specs/2026-07-11-portico-design.md)
for the full spec + implementation milestones.

## Develop

```bash
npm install
cp .env.example .env      # fill in the PORTICO_* values
npm run dev               # tsx watch
npm test                  # vitest
npm run typecheck
```

Requires Node >= 20 and (for the full stack) Postgres, an Azure Blob container,
and an Entra app registration. Domain and application tests run with no infra.

## Status

Feature-complete MVP. All eight milestones are implemented and tested:

1. Scaffold, config, ports, hexagonal layout
2. Entra OIDC identity, bearer tokens, sessions
3. `/mcp` Streamable HTTP endpoint + Portico management tools
4. Upstream OAuth linking (auth-code + PKCE) + encrypted vault
5. Proxy engine — aggregate + route upstream MCP tools
6. HTML artifact host (Azure Blob + login-gated viewer)
7. Azure deployment (Dockerfile, Container Apps bicep, runbook)
8. Jean integration guide

The full suite runs with no external infra (in-memory adapters); Postgres/Azure
back the same behaviour in production.
