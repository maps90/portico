# Connecting Jean to portico

[Jean](../../jean) is a Slack-native Claude Code runtime built on
`claude-agent-sdk`. It already speaks through one in-process MCP server
(`jean_slack`). portico is attached as an **additional, remote** MCP server, so
Jean gains every tool the user has linked (Jira, Google Drive, GitHub, …) plus
the artifact host — all behind one bearer token.

## The model

- A user signs in once at `https://<portico-domain>/` (Sign in with Google) and gets
  **one bearer token**, then links their services from the portal.
- Jean attaches portico as an HTTP MCP server, sending that token as
  `Authorization: Bearer <token>`.
- portico resolves the token → user, and exposes that user's namespaced upstream
  tools (`mcp__portico__atlassian__…`, `mcp__portico__gdrive__…`) plus the management
  and artifact tools (`mcp__portico__portico__*`).

## Wiring it into Jean

Jean builds its agent options in `src/jean/server.py::options_factory`. Add
portico to `mcp_servers` and allow its tools:

```python
def options_factory(resume: str | None) -> ClaudeAgentOptions:
    mcp_servers = {"jean_slack": server_mcp}
    allowed = list(tool_names)

    portico_token = current_portico_token()  # see "Per-user tokens" below
    if portico_token:
        mcp_servers["portico"] = {
            "type": "http",
            "url": "https://<portico-domain>/mcp",
            "headers": {"Authorization": f"Bearer {portico_token}"},
        }
        allowed.append("mcp__portico__*")  # or list specific tools

    return ClaudeAgentOptions(
        system_prompt=compose_system_prompt(persona_text),
        mcp_servers=mcp_servers,
        allowed_tools=allowed,
        permission_mode=settings.permission_mode,
        can_use_tool=_allow_all_tools,
        resume=resume,
        model=settings.model,
        cwd=str(settings.home / "workspaces"),
    )
```

External MCP tools are exposed to the model as
`mcp__<server>__<tool>`. Because Portico already namespaces upstream tools, an
Atlassian tool becomes `mcp__portico__atlassian__create_issue`, and the management
tools become `mcp__portico__portico__list_connections` etc. (Name the server something
other than `portico` if the doubled prefix bothers you.)

## Per-user tokens (recommended)

Portico issues **one token per OIDC user**, so each Slack user should use their own.
`options_factory` currently receives only `resume`; thread the requesting user's
Portico token through the same way Jean threads `routing` (channel/thread):

1. Add an `portico_tokens` table/port in Jean mapping Slack `user_id` → Portico bearer.
2. When a user first needs it, Jean DMs them the portal link; they sign in, copy the
   token, and paste it back to Jean, which stores it.
3. Have `options_factory` read the current turn's Slack user (via a routing-style
   context) and inject that user's token.

### Shared-token quickstart

For an initial rollout you can use **one** Portico token (a shared team account's)
for all Jean users — everyone then shares that account's connected services. Put
it in Jean's config/env and return it from `current_portico_token()`. Migrate to
per-user tokens when you need per-person authorization.

## Connecting a service (the UX)

1. User asks Jean to do something needing, say, Jira.
2. If not linked, the proxied call returns an actionable message, or Jean calls
   `portico__connect` with `{"service": "atlassian"}` and gets back a URL.
3. Jean posts the URL into the Slack thread; the user opens it, authorizes with
   the vendor, and returns.
4. The tools are available immediately on the next turn — no Jean restart. Token
   refresh is handled server-side by Portico.

## Publishing rich HTML back to Slack

Slack can't render rich HTML inline. When Jean produces a report/dashboard:

1. Jean calls `portico__publish_html` with the HTML (optionally `title`,
   `visibility`, `expiresInSeconds`).
2. Portico stores it and returns a **login-gated** URL.
3. Jean posts the URL into the thread. Teammates open it in a browser; they must
   be signed in to Portico (an allowed Google domain) to view — links are not
   world-readable.

## Notes

- portico is stateless per request; Jean can reconnect freely.
- A `401` from `/mcp` means the token is missing/invalid/revoked — prompt the user
  to sign in again at the portal (regenerating a token in the portal revokes the old
  one, so Jean's stored copy must be updated).
- Portico holds all upstream OAuth tokens encrypted server-side; Jean never sees
  vendor credentials.
