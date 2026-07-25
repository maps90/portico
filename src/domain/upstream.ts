/** Upstream registry: declarative description of each proxied MCP server. */

export interface UpstreamOAuth {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  /** Extra static query params on the authorize URL (provider quirks, e.g.
   *  Google's `access_type=offline`, Atlassian's `audience`). */
  authorizeParams?: Record<string, string>;
}

export interface UpstreamEntry {
  /** Stable id, also the env-key segment (e.g. `google-drive`). */
  id: string;
  displayName: string;
  /** Remote MCP endpoint (Streamable HTTP) this upstream is proxied from. */
  mcpUrl: string;
  /** Tool-name prefix, e.g. `gdrive` → `gdrive__search_files`. */
  toolPrefix: string;
  /** "proxied" = forward to a remote MCP (`mcpUrl`); "builtin" = tools implemented in-process. */
  kind: "proxied" | "builtin";
  oauth: UpstreamOAuth;
}

/** A read-only view over the configured upstreams. */
export class Registry {
  constructor(private readonly entries: Map<string, UpstreamEntry>) {}

  get(id: string): UpstreamEntry | undefined {
    return this.entries.get(id);
  }

  byPrefix(prefix: string): UpstreamEntry | undefined {
    return [...this.entries.values()].find((e) => e.toolPrefix === prefix);
  }

  list(): UpstreamEntry[] {
    return [...this.entries.values()];
  }

  /** True when OAuth client creds + endpoints are present, so linking can run. */
  isConfigured(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    const credsOk =
      e.oauth.clientId !== "" &&
      e.oauth.clientSecret !== "" &&
      e.oauth.authorizationUrl !== "" &&
      e.oauth.tokenUrl !== "";
    if (!credsOk) return false;
    return e.kind === "builtin" ? true : e.mcpUrl !== "";
  }
}
