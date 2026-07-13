# Google identity + portal — design

**Date:** 2026-07-13
**Status:** implemented

Reshapes portico along the lines of [barockok/workbench](https://github.com/barockok/workbench):
sign in with Google, link services (Jira first) over OAuth, hold **one token** that
reaches all of them. Adds a Makefile so the thing can be run and tested with one
command.

## What changed, and why

### 1. Identity: Microsoft Entra → Google OIDC

Entra was removed outright rather than kept behind a switch — a second IdP nobody
uses is a second attack surface and a second thing to keep tested.

`GoogleOidcVerifier` implements the existing `OidcVerifier` port, so nothing above
the adapter layer knew the difference. Two claim-level changes:

- `OidcClaims.tenantId` (Entra's `tid`) → `workspace`: Google's `hd` (Workspace
  domain), falling back to the email's domain for consumer accounts.
- `OidcClaims.emailVerified` was added, and the policy **requires** it. Without it,
  an account with an unverified `@okadoc.com` address would satisfy a domain
  allowlist it has no right to.

### 2. Access gate: allowed domains, optional

`PORTICO_ALLOWED_DOMAINS` (comma-separated) replaces the single-tenant rule.
**Empty means any verified Google account** — the right default for solo/local use,
and a documented footgun for public deployments. `TenantForbiddenError` →
`DomainForbiddenError`.

The Google adapter also passes `hd` on the authorize URL when exactly one domain is
configured. That is a UX hint to the account chooser only; the decision is always
made against verified claims.

### 3. Portal: React + Vite at `/`

Served as static assets from `web/dist` by Express in production; hosted by Vite
with an API proxy in `make dev`. Talks to a new `/api/*` surface authenticated by
the **session cookie**, never by the bearer token — the bearer token is for MCP
clients, and letting it drive the portal would widen its blast radius.

Two consequences worth naming:

- **Tokens cannot be re-displayed.** They are stored hashed. So the portal shows
  metadata (count, created, last used) and offers *Generate new token*, which
  revokes every existing token and reveals the new value exactly once. This is why
  `TokenStore` grew `listActive` and `revokeAllForUser`.
- **CSRF.** Cookie-authenticated POSTs (`disconnect`, `token/rotate`) require an
  `X-Portico-Portal: 1` header, which a cross-site form cannot set, plus a trusted
  `Origin`. This complements the `SameSite=Lax` cookie.

`PORTICO_PORTAL_URL` exists solely because Vite serves the portal on its own port
in dev while OAuth callbacks land on the API's origin: post-login and post-connect
pages send the browser back to the portal, and that origin is trusted for CSRF.
Outside `make dev` it equals `PORTICO_BASE_URL`.

### 4. Google appears twice, deliberately

The login client (`openid email profile`) and the Google Drive *upstream* client
(Drive scopes) are separate OAuth clients. Sharing one would mean signing in
prompts for access to your files.

### 5. Local stack

`docker-compose.yml` runs Postgres 16. Azure Blob became optional: with a database
but no `PORTICO_ARTIFACT_BLOB_ACCOUNT`, artifact bytes go to disk
(`FilesystemArtifactStore`, path-confined to its root). With no database at all,
everything is in-memory — tests included, so the suite needs no infrastructure and
leaves nothing behind.

## Testing

91 tests, no infra. Beyond the updated identity/config tests:

- `google.test.ts` runs the adapter's real verification path (signature, audience,
  issuer) against a fake Google serving a local JWKS and token endpoint. Covers the
  `hd` fallback, unverified email, and a token minted for another client.
- `api-routes.test.ts` boots the app and drives the portal surface over HTTP: 401
  when signed out, connection states, disconnect, rotate-shows-once-and-revokes,
  and both CSRF defenses.

## Verified end to end

Booted the built server and drove the real routes: `/` serves the portal, `/login`
redirects to Google with the right scopes and `hd` hint, `/api/*` rejects anonymous
callers, a signed-in session lists connections and rotates a token, and
`/connect/atlassian` redirects to the genuine `auth.atlassian.com/authorize`.
