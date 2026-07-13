# portico — Architecture

portico is a single TypeScript service with **two capabilities on a shared
identity core**:

1. **Unified MCP proxy gateway** — Jean (or any MCP client) connects with **one
   bearer token per user** and sees the aggregated, namespaced tools of every
   upstream MCP server that user has linked. portico holds each user's per-service
   OAuth tokens server-side (AES-256-GCM encrypted) and proxies calls through.
2. **HTML artifact host** — clients publish rich HTML and get back a login-gated
   URL to share (e.g. Jean posting a report into a Slack thread).

A small React **portal** at `/` is the human surface for both: sign in with Google,
link services, manage your token.

## Layering (Hexagonal / Clean)

Dependencies point **inward only**. Adapters implement ports; the interface layer
wires everything in the composition root. Most logic is testable against
in-memory fakes with no infrastructure.

```
web/          (portal)           React + Vite; talks only to /api/*
    │  HTTP
    ▼
interface/   (pages/templates)  HTTP routes, /api, /mcp endpoint, composition root
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
adapters/     (organisms)        Postgres, Azure Blob, filesystem, Google OIDC, crypto, MCP client
```

| Directory | Responsibility | May import |
|-----------|----------------|------------|
| `src/domain/` | Entities, value objects, pure policies (allowed-domain rule, tool namespacing, token-refresh policy). No framework or I/O imports. | nothing (self-contained) |
| `src/ports/` | Structural interfaces (`UserStore`, `TokenStore`, `ConnectionVault`, `ArtifactStore`, `OidcVerifier`, …). | `domain/` types only |
| `src/application/` | Use-cases (identity, connections, proxy, artifacts) orchestrating domain + ports. | `domain/`, `ports/` |
| `src/adapters/` | Concrete infra implementing ports (pg, Azure SDKs, node:fs, jose, node:crypto, MCP SDK client). | `ports/`, `domain/`, external SDKs |
| `src/interface/` | Delivery: Express routes, the portal's `/api/*` surface, the Streamable-HTTP `/mcp` endpoint, and the composition root. | everything |
| `web/` | The React portal. Knows nothing of the server beyond the `/api/*` contract. | — |
| `src/config.ts` | Cross-cutting: `PORTICO_*` env → typed `Settings`. | zod |
| `src/main.ts` | Bootstrap: load config, open pool, start server. | `config`, `interface` |

## Two auth planes

This separation is the core idea — it's what lets one token reach many services.

- **Identity** — `/login` → Google OIDC → verify `id_token` against Google's JWKS,
  enforce the allowed-domain policy (`hd` claim, falling back to the email domain)
  → upsert user → mint an opaque bearer token (stored hashed) for Jean's config
  **and** set a signed session cookie for the portal and artifact viewing.
- **Connections** — per user, per upstream OAuth 2.1 auth-code + PKCE against each
  vendor; tokens encrypted in the vault; auto-refresh on expiry. Linking or
  unlinking a service never changes the user's portico token.

Because bearer tokens are stored hashed, an existing one can never be re-displayed.
The portal's "generate new token" revokes every previous token and shows the new
value exactly once.

## Adapter selection

Chosen at boot, so the same code runs locally and in Azure:

| Port | No `PORTICO_DATABASE_URL` | With a database |
|---|---|---|
| Users, tokens, vault, OAuth state, artifact metadata | in-memory (tests, throwaway dev) | Postgres |
| Artifact bytes | in-memory | Azure Blob if `PORTICO_ARTIFACT_BLOB_ACCOUNT` is set, else the local filesystem |

## Testing strategy

Domain and application layers are exercised against in-memory fakes of the ports —
no Postgres, Azure, or network. Adapters get their own tests: the Google OIDC
verifier runs its real verification path against a fake Google (local JWKS + token
endpoint), and the proxy path against a fake upstream MCP server. Route tests boot
the full app and drive it over HTTP, covering login, linking, the portal's API
(including its CSRF defenses), and the `/mcp` endpoint.

See `docs/superpowers/specs/2026-07-11-portico-design.md` for the original design
and implementation milestones.
