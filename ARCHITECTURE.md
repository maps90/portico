# portico — Architecture

portico is a single TypeScript service with **two capabilities on a shared
identity core**:

1. **Unified MCP proxy gateway** — Jean (or any MCP client) connects with **one
   bearer token per OIDC user** and sees the aggregated, namespaced tools of every
   upstream MCP server that user has linked. portico holds each user's per-service
   OAuth tokens server-side (AES-256-GCM encrypted) and proxies calls through.
2. **HTML artifact host** — clients publish rich HTML and get back a login-gated
   URL to share (e.g. Jean posting a report into a Slack thread).

Target deployment: **Okadoc on Azure** — Microsoft Entra identity (single-tenant),
Azure Blob Storage for artifact bytes, Azure Database for PostgreSQL, Key Vault
for secrets.

## Layering (Hexagonal / Clean)

Dependencies point **inward only**. Adapters implement ports; the interface layer
wires everything in the composition root. Most logic is testable against
in-memory fakes with no infrastructure.

```
interface/   (pages/templates)  HTTP routes, /mcp endpoint, composition root
    │  depends on
    ▼
application/  (molecules)        use-cases composing domain + ports
    │  depends on
    ▼
domain/       (atoms)            pure entities, value objects, policies — no I/O
    ▲  implements
    │
ports/        (sockets)          interfaces the inner layers depend on
    ▲
    │  implements
adapters/     (organisms)        Postgres, Azure Blob, Entra OIDC, crypto, MCP client
```

| Directory | Responsibility | May import |
|-----------|----------------|------------|
| `src/domain/` | Entities, value objects, pure policies (tenant rule, tool namespacing, token-refresh policy). No framework or I/O imports. | nothing (self-contained) |
| `src/ports/` | Structural interfaces (`UserStore`, `TokenStore`, `ConnectionVault`, `ArtifactStore`, `OidcVerifier`, …). | `domain/` types only |
| `src/application/` | Use-cases (identity, connections, proxy, artifacts) orchestrating domain + ports. | `domain/`, `ports/` |
| `src/adapters/` | Concrete infra implementing ports (pg, Azure SDKs, jose, node:crypto, MCP SDK client). | `ports/`, `domain/`, external SDKs |
| `src/interface/` | Delivery: Express routes, the Streamable-HTTP `/mcp` endpoint, and the composition root that builds adapters and injects them. | everything |
| `src/config.ts` | Cross-cutting: `PORTICO_*` env → typed `Settings`. | zod |
| `src/main.ts` | Bootstrap: load config, open pool, start server. | `config`, `interface` |

## Two auth planes

- **Identity** — `/login` → Entra OIDC → verify `id_token`, enforce Okadoc tenant
  (`tid`) → upsert user → mint opaque bearer token (stored hashed) for Jean's
  config **and** set a signed session cookie for browser artifact viewing.
- **Connections** — per user, per upstream OAuth 2.1 auth-code + PKCE against each
  service's MCP server; tokens encrypted in the vault; auto-refresh on expiry.

## Testing strategy

Domain and application layers are exercised against in-memory fakes of the ports —
no Postgres, Azure, or network. Adapters get their own integration tests
(Postgres gated on a test DB URL; a fake upstream MCP server + fake Entra for the
proxy path). One end-to-end test covers login → mint token → connect a fake
upstream → list + call a proxied tool. This mirrors the sibling `jean` project,
where the in-memory and Postgres adapters are proven against one behavioral suite.

See `docs/superpowers/specs/2026-07-11-portico-design.md` for the full design and
implementation milestones.
