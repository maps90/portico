import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { User } from "../../ports/identity.js";
import type { ConnectionsService } from "../../application/connections-service.js";
import type { ProxyService } from "../../application/proxy-service.js";

export interface OmniServerDeps {
  connections: ConnectionsService;
  proxy: ProxyService;
}

const text = (value: unknown): CallToolResult => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
});

interface OmniTool {
  def: Tool;
  handle: (user: User, args: Record<string, unknown>) => Promise<CallToolResult>;
}

/** The `omni__*` management tools, defined as raw MCP tool specs + handlers. */
function omniTools(deps: OmniServerDeps): OmniTool[] {
  const serviceArg: Tool["inputSchema"] = {
    type: "object",
    properties: { service: { type: "string", description: "upstream service id, e.g. 'atlassian'" } },
    required: ["service"],
  };
  return [
    {
      def: {
        name: "omni__list_connections",
        description:
          "List every upstream service, its state (connected / expired / not_connected / unavailable), and a connect link where applicable.",
        inputSchema: { type: "object", properties: {} },
      },
      handle: async (user) => text(await deps.connections.list(user)),
    },
    {
      def: {
        name: "omni__connect",
        description:
          "Return a URL the user should open to authorize a service (e.g. 'atlassian', 'google-drive', 'github'). Share the URL with the user.",
        inputSchema: serviceArg,
      },
      handle: async (user, args) => {
        const service = String(args.service ?? "");
        const list = await deps.connections.list(user);
        const entry = list.find((c) => c.id === service);
        if (!entry) return text(`Unknown service '${service}'. Available: ${list.map((c) => c.id).join(", ")}`);
        if (entry.state === "unavailable") return text(`Service '${service}' is not configured on this omni instance.`);
        if (entry.state === "connected") return text(`'${service}' is already connected.`);
        return text(`Open this URL to connect ${entry.displayName}:\n${entry.connectUrl}`);
      },
    },
    {
      def: {
        name: "omni__disconnect",
        description: "Forget the stored authorization for a service, so its tools stop working until reconnected.",
        inputSchema: serviceArg,
      },
      handle: async (user, args) => {
        const service = String(args.service ?? "");
        const ok = await deps.connections.disconnect(user, service);
        return text(ok ? `Disconnected '${service}'.` : `Unknown service '${service}'.`);
      },
    },
  ];
}

/**
 * Builds a per-user, per-request MCP gateway server. `tools/list` merges the
 * omni management tools with the user's namespaced upstream tools; `tools/call`
 * dispatches omni tools locally and routes everything else to the proxy.
 */
export async function buildOmniServer(user: User, deps: OmniServerDeps): Promise<Server> {
  const server = new Server(
    { name: "omni-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Unified gateway. omni__list_connections shows linked services; omni__connect returns a link to authorize a new one. Other tools are namespaced <service>__<tool>.",
    },
  );
  const locals = omniTools(deps);
  const localByName = new Map(locals.map((t) => [t.def.name, t] as const));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const proxied = await deps.proxy.listTools(user);
    for (const e of proxied.errors) {
      console.warn(`upstream '${e.upstreamId}' listTools failed: ${e.message}`);
    }
    return { tools: [...locals.map((t) => t.def), ...proxied.tools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const local = localByName.get(name);
    if (local) return local.handle(user, args ?? {});
    return deps.proxy.callTool(user, name, args ?? {});
  });

  return server;
}
