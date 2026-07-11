import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamGateway } from "../../ports/upstream.js";

/**
 * UpstreamGateway backed by the MCP SDK client over Streamable HTTP. Opens a
 * fresh connection per operation and closes it after — consistent with the
 * stateless per-request `/mcp` handler. (A per-(user,upstream) client pool is a
 * possible future optimization; correctness with token refresh is simpler this
 * way.)
 */
export class McpUpstreamGateway implements UpstreamGateway {
  private async withClient<T>(
    mcpUrl: string,
    accessToken: string,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ name: "portico-proxy", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    try {
      await client.connect(transport);
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async listTools(mcpUrl: string, accessToken: string): Promise<Tool[]> {
    return this.withClient(mcpUrl, accessToken, async (client) => {
      const { tools } = await client.listTools();
      return tools;
    });
  }

  async callTool(
    mcpUrl: string,
    accessToken: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    return this.withClient(mcpUrl, accessToken, (client) =>
      client.callTool({ name, arguments: args }),
    ) as Promise<CallToolResult>;
  }
}
