import { Registry, type UpstreamEntry } from "../../domain/upstream.js";

/**
 * The launch set of upstream MCP servers. Each entry ships sensible default
 * endpoints; MCP URL and OAuth client creds are read from env so ops set exact
 * values per environment. An upstream with missing creds still appears in the
 * registry but `Registry.isConfigured` returns false and linking is refused.
 *
 * Env keys per upstream id `X` (dashes → underscores, upper-cased):
 *   PORTICO_UPSTREAM_X_MCP_URL, PORTICO_UPSTREAM_X_CLIENT_ID, PORTICO_UPSTREAM_X_CLIENT_SECRET
 */

interface Seed {
  id: string;
  displayName: string;
  defaultMcpUrl: string;
  toolPrefix: string;
  kind: "proxied" | "builtin";
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  authorizeParams?: Record<string, string>;
}

const SEEDS: Seed[] = [
  {
    id: "atlassian",
    displayName: "Atlassian (Jira & Confluence)",
    defaultMcpUrl: "https://mcp.atlassian.com/v1/sse",
    toolPrefix: "atlassian",
    kind: "proxied",
    authorizationUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    // Listing tools needs no permission; invoking them does. Get this list wrong
    // and Atlassian advertises all 40 tools, then fails every single call with
    // "We are having trouble completing this action. Please try again shortly." --
    // a message that names neither the scope nor the tool, and sends you looking
    // for a transport bug or a rate limit that isn't there.
    //
    // `read:me` is the one that was missing, and it is why *every* call failed,
    // not just the Jira ones: even `atlassianUserInfo` -- no arguments, no cloudId
    // -- is refused without it. Note it is NOT a Jira or Confluence scope. It lives
    // under a separate "User identity API" that must be added to the app on
    // developer.atlassian.com, which is exactly why it is easy to miss.
    //
    // The Confluence scopes here are Atlassian's *classic* set. Granular ones
    // (read:page:confluence, ...) are not offered on a classic app, and an app
    // cannot mix the two dialects -- so do not "upgrade" one of these in isolation.
    //
    // Atlassian documents the set its MCP server requires nowhere -- not the
    // support site, not the official repo -- so treat this as the best known set
    // and override with PORTICO_UPSTREAM_ATLASSIAN_SCOPES rather than redeploying.
    scopes: [
      "read:me",
      "read:jira-work",
      "read:jira-user",
      "write:jira-work",
      "read:confluence-content.all",
      "read:confluence-space.summary",
      "write:confluence-content",
      "search:confluence",
      "offline_access",
    ],
    authorizeParams: { audience: "api.atlassian.com", prompt: "consent" },
  },
  {
    id: "google-drive",
    displayName: "Google Drive",
    defaultMcpUrl: "",
    toolPrefix: "gdrive",
    kind: "proxied",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/drive.readonly", "openid", "email"],
    authorizeParams: { access_type: "offline", prompt: "consent" },
  },
  {
    id: "github",
    displayName: "GitHub",
    defaultMcpUrl: "https://api.githubcopilot.com/mcp/",
    toolPrefix: "github",
    kind: "proxied",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:org"],
  },
  {
    id: "google-docs",
    displayName: "Google Docs",
    kind: "builtin",
    defaultMcpUrl: "",
    toolPrefix: "gdocs",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive.file",
    ],
    authorizeParams: { access_type: "offline", prompt: "consent" },
  },
];

const envKey = (id: string, suffix: string): string =>
  `PORTICO_UPSTREAM_${id.replace(/-/g, "_").toUpperCase()}_${suffix}`;

/**
 * `PORTICO_UPSTREAM_X_SCOPES` — space- or comma-separated, overriding the seed.
 *
 * An upstream's required scopes are the provider's business and are not always
 * documented (Atlassian's MCP server enumerates its own nowhere), so finding the
 * right set can take a round or two. Without this, each attempt is a code change,
 * a build and a deploy. A blank value is an ops accident, not a request for zero
 * scopes — fall back to the seed rather than ask for nothing, which is exactly the
 * grant that makes every tool call fail.
 */
const scopesFrom = (raw: string | undefined, fallback: string[]): string[] => {
  const parsed = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
};

export function buildRegistry(env: Record<string, string | undefined>): Registry {
  const entries = new Map<string, UpstreamEntry>();
  for (const s of SEEDS) {
    entries.set(s.id, {
      id: s.id,
      displayName: s.displayName,
      mcpUrl: env[envKey(s.id, "MCP_URL")] ?? s.defaultMcpUrl,
      toolPrefix: s.toolPrefix,
      kind: s.kind,
      oauth: {
        authorizationUrl: s.authorizationUrl,
        tokenUrl: s.tokenUrl,
        scopes: scopesFrom(env[envKey(s.id, "SCOPES")], s.scopes),
        clientId: env[envKey(s.id, "CLIENT_ID")] ?? "",
        clientSecret: env[envKey(s.id, "CLIENT_SECRET")] ?? "",
        ...(s.authorizeParams ? { authorizeParams: s.authorizeParams } : {}),
      },
    });
  }
  return new Registry(entries);
}
