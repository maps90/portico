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
    authorizationUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scopes: ["read:jira-work", "write:jira-work", "read:confluence-content.all", "offline_access"],
    authorizeParams: { audience: "api.atlassian.com", prompt: "consent" },
  },
  {
    id: "google-drive",
    displayName: "Google Drive",
    defaultMcpUrl: "",
    toolPrefix: "gdrive",
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
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:org"],
  },
];

const envKey = (id: string, suffix: string): string =>
  `PORTICO_UPSTREAM_${id.replace(/-/g, "_").toUpperCase()}_${suffix}`;

export function buildRegistry(env: Record<string, string | undefined>): Registry {
  const entries = new Map<string, UpstreamEntry>();
  for (const s of SEEDS) {
    entries.set(s.id, {
      id: s.id,
      displayName: s.displayName,
      mcpUrl: env[envKey(s.id, "MCP_URL")] ?? s.defaultMcpUrl,
      toolPrefix: s.toolPrefix,
      oauth: {
        authorizationUrl: s.authorizationUrl,
        tokenUrl: s.tokenUrl,
        scopes: s.scopes,
        clientId: env[envKey(s.id, "CLIENT_ID")] ?? "",
        clientSecret: env[envKey(s.id, "CLIENT_SECRET")] ?? "",
        ...(s.authorizeParams ? { authorizeParams: s.authorizeParams } : {}),
      },
    });
  }
  return new Registry(entries);
}
