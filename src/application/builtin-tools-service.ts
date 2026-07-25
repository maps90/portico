import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { User } from "../ports/identity.js";
import type { BuiltinProvider, RestClient } from "../ports/builtin.js";
import type { AccessTokenProvider } from "./access.js";
import { namespaceTool, parseTool } from "../domain/tool-names.js";

export interface BuiltinDeps {
  providers: BuiltinProvider[];
  access: AccessTokenProvider;
  makeHttp: (token: string) => RestClient;
  baseUrl: string;
}

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }], isError: true,
});

/**
 * Lists and dispatches in-process builtin tools. Mirrors ProxyService, but the
 * tools are implemented locally instead of forwarded to a remote MCP. Gated on the
 * same `getFresh` connection check, so an unlinked/expired provider advertises
 * nothing and calling it prompts a reconnect.
 */
export class BuiltinToolsService {
  constructor(private readonly deps: BuiltinDeps) {}

  private byPrefix(prefix: string): BuiltinProvider | undefined {
    return this.deps.providers.find((p) => p.toolPrefix === prefix);
  }
  private connectUrl(id: string): string {
    return `${this.deps.baseUrl}/connect/${encodeURIComponent(id)}`;
  }

  async listTools(user: User): Promise<Tool[]> {
    const out: Tool[] = [];
    for (const p of this.deps.providers) {
      const fresh = await this.deps.access.getFresh(user.id, p.id);
      if (!fresh) continue;
      for (const t of p.tools) out.push({ ...t.def, name: namespaceTool(p.toolPrefix, t.def.name) });
    }
    return out;
  }

  /** Returns null when `name` is not a builtin tool, so the caller falls through to the proxy. */
  async callTool(user: User, name: string, args: Record<string, unknown>): Promise<CallToolResult | null> {
    const parsed = parseTool(name);
    if (!parsed) return null;
    const provider = this.byPrefix(parsed.prefix);
    if (!provider) return null;
    const tool = provider.tools.find((t) => t.def.name === parsed.name);
    if (!tool) return errorResult(`Unknown tool '${name}'.`);
    const fresh = await this.deps.access.getFresh(user.id, provider.id);
    if (!fresh) {
      return errorResult(
        `'${provider.id}' is not connected (or its authorization expired). ` +
          `Ask the user to open ${this.connectUrl(provider.id)} to connect.`,
      );
    }
    return tool.handle({ http: this.deps.makeHttp(fresh.accessToken) }, args);
  }
}
