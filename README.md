# omni-mcp

A unified **MCP gateway** + **HTML artifact host** for Okadoc.

- **Gateway** — log into the omni channel once via Microsoft Entra (Okadoc
  tenant) and get **one bearer token**. Point Jean (or any MCP client) at
  omni-mcp with that token and it sees the aggregated, namespaced tools of every
  upstream MCP server you've linked (Jira, Google Drive, GitHub, Confluence, …).
  omni-mcp holds each user's per-service OAuth tokens server-side, encrypted, and
  proxies calls through.
- **Artifact host** — publish rich HTML (reports/dashboards) and get back a
  login-gated URL. Bytes live in Azure Blob Storage; only authenticated omni
  users can view.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the design and
[`docs/superpowers/specs/2026-07-11-omni-mcp-design.md`](docs/superpowers/specs/2026-07-11-omni-mcp-design.md)
for the full spec + implementation milestones.

## Develop

```bash
npm install
cp .env.example .env      # fill in the OMNI_* values
npm run dev               # tsx watch
npm test                  # vitest
npm run typecheck
```

Requires Node >= 20 and (for the full stack) Postgres, an Azure Blob container,
and an Entra app registration. Domain and application tests run with no infra.

## Status

Under construction — see the milestone tasks. **M1 (scaffold + config + ports +
health)** is done; identity, MCP endpoint, upstream proxy, and artifact host
follow.
