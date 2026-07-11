import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectionVault } from "../ports/connections.js";
import type { User } from "../ports/identity.js";
import type { UpstreamGateway } from "../ports/upstream.js";
import type { Registry } from "../domain/upstream.js";
import { namespaceTool, parseTool } from "../domain/tool-names.js";
import type { AccessTokenProvider } from "./access.js";

export interface ProxyDeps {
  registry: Registry;
  vault: ConnectionVault;
  access: AccessTokenProvider;
  gateway: UpstreamGateway;
  baseUrl: string;
}

export interface AggregatedTools {
  tools: Tool[];
  /** Upstreams that were connected but failed to list (skipped, not fatal). */
  errors: Array<{ upstreamId: string; message: string }>;
}

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/**
 * Aggregates and routes upstream MCP tools for one user. `listTools` fans out to
 * every connected upstream, namespaces tool names, and skips (records) any that
 * are unreachable. `callTool` parses the prefix, refreshes the token, and
 * forwards to the owning upstream — returning an actionable connect prompt when
 * the service is not linked or has expired.
 */
export class ProxyService {
  constructor(private readonly deps: ProxyDeps) {}

  private connectUrl(upstreamId: string): string {
    return `${this.deps.baseUrl}/connect/${encodeURIComponent(upstreamId)}`;
  }

  async listTools(user: User): Promise<AggregatedTools> {
    const conns = await this.deps.vault.list(user.id);
    const out: Tool[] = [];
    const errors: AggregatedTools["errors"] = [];

    for (const conn of conns) {
      const entry = this.deps.registry.get(conn.upstreamId);
      if (!entry) continue;
      const fresh = await this.deps.access.getFresh(user.id, conn.upstreamId);
      if (!fresh) continue; // not active / expired → omit; user reconnects
      try {
        const tools = await this.deps.gateway.listTools(entry.mcpUrl, fresh.accessToken);
        for (const t of tools) {
          out.push({ ...t, name: namespaceTool(entry.toolPrefix, t.name) });
        }
      } catch (err) {
        errors.push({ upstreamId: conn.upstreamId, message: String(err) });
      }
    }
    return { tools: out, errors };
  }

  async callTool(
    user: User,
    namespacedName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = parseTool(namespacedName);
    if (!parsed) return errorResult(`Unknown tool '${namespacedName}'.`);

    const entry = this.deps.registry.byPrefix(parsed.prefix);
    if (!entry) return errorResult(`No upstream for tool prefix '${parsed.prefix}'.`);

    const fresh = await this.deps.access.getFresh(user.id, entry.id);
    if (!fresh) {
      return errorResult(
        `'${entry.displayName}' is not connected (or its authorization expired). ` +
          `Ask the user to open ${this.connectUrl(entry.id)} to reconnect.`,
      );
    }

    try {
      return await this.deps.gateway.callTool(entry.mcpUrl, fresh.accessToken, parsed.name, args);
    } catch (err) {
      return errorResult(`Upstream '${entry.displayName}' failed: ${String(err)}`);
    }
  }
}
