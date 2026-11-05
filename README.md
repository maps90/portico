# portico

A unified **MCP gateway** + **HTML artifact host**. One token, every service.

- **Gateway** — sign in with Google, link Jira and Google Drive from the portal, and
  get **one bearer token**. Point Jean (or any MCP client) at
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
  script can draw a chart but cannot read your session cookie, see the parent page, or fetch
  from the network — a malicious page could at most leak data it already contains, never
  anything of yours. Bytes live on disk locally, in Azure Blob Storage in production.

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
| `PORTICO_UPSTREAM_SLACK_CLIENT_ID` / `_SECRET` | api.slack.com/apps → your app → OAuth & Permissions. Redirect URL: `https://<host>/connect/slack/callback` (Slack requires HTTPS). **Bot** token scopes: `chat:write`, `reactions:write`, `channels:read`, `groups:read`, `im:read`, `mpim:read`. See [Slack guardrails](#slack-guardrails). |
| `PORTICO_SLACK_ALLOWED_REACTIONS` | Optional. Reactions the bot may add, comma-separated. Default `eyes,white_check_mark,pray`. |
| `PORTICO_SLACK_DENY_CHANNELS` | Optional. Channel ids the bot must never write to, comma-separated. |
| `PORTICO_SLACK_MAX_POSTS_PER_HOUR` | Optional. Posts per portico user per rolling hour, default `20`. Kept in memory, so it is **per instance**. |
| `PORTICO_UPSTREAM_GOOGLE_DRIVE_CLIENT_ID` / `_SECRET` | Google Cloud Console → Credentials → OAuth client ID (Web application). Redirect URI: `http://localhost:8080/connect/google-drive/callback`. Enable the Drive, **Sheets**, **Slides** and Docs APIs — Sheets and Slides are separate services, and without them a spreadsheet or deck stays unreadable no matter what Drive grants. |

`make setup` generates `PORTICO_ENCRYPTION_KEY` and `PORTICO_SESSION_SECRET` for you.
GitHub follows the same `PORTICO_UPSTREAM_<ID>_*` pattern and simply shows as
*Not configured* in the portal until you fill it in.

## What you actually get

| Prefix | Served by | Tools |
|---|---|---|
| `jira__` | builtin, over Jira Cloud REST | `search`, `get_issue`, `create_issue`, `edit_issue`, `add_comment`, `list_projects` |
| `gdocs__` | builtin, over the Docs + Drive REST APIs | `create_document`, `get_document`, `append_text`, `list_documents` |
| `gdrive__` | builtin, over the Drive + Sheets + Slides REST APIs | `search_files`, `get_file`, `export_file`, `list_sheets`, `read_sheet`, `read_presentation` |
| `slack__` | builtin, over the Slack Web API, **as a bot**, send-only | `reply`, `react` — every write passes the [Slack guardrails](#slack-guardrails) first |
| `github__` | proxied to GitHub's hosted MCP | whatever that server advertises — **unconfigured by default, so no tools appear** |

Every builtin provider reuses a connection you already made: `jira__*` rides the
`atlassian` grant and `gdrive__*`/`gdocs__*` share the single `google-drive` grant,
so none of them needs separate setup. A provider is a tool prefix, not a second
login — adding a Google API means new scopes, not new credentials.

Two limits worth knowing before you hit them:

- **Confluence is not served.** Its scopes are still requested on the `atlassian`
  connection so that adding a provider later needs no re-consent, but no provider
  claims them today and the hosted Atlassian MCP is not proxied (see the note in
  `adapters/registry/default-registry.ts` for why — it authenticates, lists all 40
  tools, then refuses every call).
- **`gdrive__*` is read-only, and `gdocs__*` is the only way to write.** The Drive,
  Sheets and Slides scopes are all `.readonly`; the one write grant (`documents`)
  reaches Docs alone. Nothing here can delete a file or edit a spreadsheet.

## Slack guardrails

`slack__*` speaks as the app's **bot user**, never as whoever clicked Connect, and it
only sends: reading Slack stays on the Slack MCP. There is no read, edit, delete,
upload, invite, channel-create or search tool. The rules are code
(`src/domain/slack-policy.ts`), not prompt, and run before any write call; a refusal
returns an error naming the rule and **makes no post**:

- **Threads only.** `reply` needs `thread_ts` in any channel that is not a DM (`D…`),
  and the thread's parent must exist (checked with `chat.getPermalink`) — the bot never
  starts a top-level channel post.
- **No Slack Connect.** A channel `conversations.info` reports as `is_ext_shared`,
  `is_shared` or pending-shared is refused, for replies and reactions. If the info
  cannot be read, the write is refused (fails closed).
- **No secrets or internal network data** in the text: Slack tokens, private key
  blocks, JWTs, AWS access keys, GitHub tokens, `password/secret/token/api_key/psk`
  `=`/`:` a value, connection strings with credentials, and private IPs (10/8,
  172.16/12, 192.168/16, 100.64/10). The match is never echoed back.
- **No mass mentions:** `<!here>`, `<!channel>`, `<!everyone>`, `@here`, `@channel`.
- **Reaction allowlist:** `eyes`, `white_check_mark`, `pray` (`PORTICO_SLACK_ALLOWED_REACTIONS`).
- **Deny list:** `PORTICO_SLACK_DENY_CHANNELS` channel ids are never written to.
- **Rate limit:** `PORTICO_SLACK_MAX_POSTS_PER_HOUR` (default 20) posts per portico user
  per rolling hour — in memory, so per instance.
- **Length:** at most 4000 characters.
- **Audit:** every write attempt, allowed or refused, logs one `slack audit {…}` line
  with user id, tool, channel, `thread_ts`, outcome and rule — never the message text.

Slack app setup: create an app at api.slack.com/apps, add the six bot scopes above and
the redirect URL, then **invite the bot to every channel it should reply in** (`/invite
@<app>`) — a bot can only post where it is a member. Connecting installs the app to the
workspace, which may need a workspace admin's approval.

Paged tools — `jira__search`, `jira__list_projects`, `gdocs__list_documents`,
`gdrive__search_files` — return **one page**. Each says so in its description and
hands back the cursor to continue with; a count taken from a single page is not a
total.

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

Feature-complete. The default suite (265 tests) runs entirely on in-memory adapters — no
database, no cloud, no credentials. `make test-e2e` additionally drives a real browser to
verify the visual sandbox holds; it is the only test that needs one.
