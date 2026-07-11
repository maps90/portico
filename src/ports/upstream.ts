import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * A narrow client to one upstream MCP server. Given the endpoint and a bearer
 * access token, it lists tools and forwards calls. The real adapter opens an MCP
 * SDK client per operation; tests use a fake. Keeping the port to (url, token)
 * rather than the whole registry entry keeps upstream concerns out of it.
 */
export interface UpstreamGateway {
  listTools(mcpUrl: string, accessToken: string): Promise<Tool[]>;
  callTool(
    mcpUrl: string,
    accessToken: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
}
