import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { User } from "../../ports/identity.js";
import type { ConnectionsService } from "../../application/connections-service.js";

export interface OmniServerDeps {
  connections: ConnectionsService;
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/**
 * Builds a per-user MCP server exposing the `omni__*` management tools. One
 * instance is created per request in the stateless `/mcp` handler, scoped to the
 * authenticated user. Later milestones also register the user's proxied upstream
 * tools (M5) and `omni__publish_html` (M6) on this server.
 */
export function buildOmniServer(user: User, deps: OmniServerDeps): McpServer {
  const server = new McpServer(
    { name: "omni-mcp", version: "0.1.0" },
    { instructions: "Unified gateway. Use omni__list_connections to see linked services; omni__connect returns a link to authorize a new one." },
  );

  server.registerTool(
    "omni__list_connections",
    {
      title: "List connected services",
      description:
        "List every upstream service, its connection state (connected / expired / not_connected / unavailable), and a connect link where applicable.",
      inputSchema: {},
    },
    async () => text(await deps.connections.list(user)),
  );

  server.registerTool(
    "omni__connect",
    {
      title: "Connect a service",
      description:
        "Return a URL the user should open to authorize omni to access a service (e.g. 'atlassian', 'google-drive', 'github'). Share the URL with the user.",
      inputSchema: { service: z.string().describe("upstream service id, e.g. 'atlassian'") },
    },
    async ({ service }) => {
      const list = await deps.connections.list(user);
      const entry = list.find((c) => c.id === service);
      if (!entry) return text(`Unknown service '${service}'. Available: ${list.map((c) => c.id).join(", ")}`);
      if (entry.state === "unavailable")
        return text(`Service '${service}' is not configured on this omni instance.`);
      if (entry.state === "connected")
        return text(`'${service}' is already connected.`);
      return text(`Open this URL to connect ${entry.displayName}:\n${entry.connectUrl}`);
    },
  );

  server.registerTool(
    "omni__disconnect",
    {
      title: "Disconnect a service",
      description: "Forget the stored authorization for a service, so its tools stop working until reconnected.",
      inputSchema: { service: z.string().describe("upstream service id") },
    },
    async ({ service }) => {
      const ok = await deps.connections.disconnect(user, service);
      return text(ok ? `Disconnected '${service}'.` : `Unknown service '${service}'.`);
    },
  );

  return server;
}
