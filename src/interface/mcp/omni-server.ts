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
import type { ArtifactsService } from "../../application/artifacts-service.js";

export interface OmniServerDeps {
  connections: ConnectionsService;
  proxy: ProxyService;
  artifacts: ArtifactsService;
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
    {
      def: {
        name: "omni__publish_html",
        description:
          "Publish an HTML document (report/dashboard) and get back a login-gated URL to share (e.g. post into a Slack thread). Only authenticated omni users can open it.",
        inputSchema: {
          type: "object",
          properties: {
            html: { type: "string", description: "the full HTML document to host" },
            title: { type: "string", description: "optional title" },
            visibility: {
              type: "string",
              enum: ["authenticated", "private"],
              description: "'authenticated' (any signed-in omni user, default) or 'private' (only you)",
            },
            expiresInSeconds: { type: "number", description: "optional lifetime; omit for no expiry" },
          },
          required: ["html"],
        },
      },
      handle: async (user, args) => {
        const html = typeof args.html === "string" ? args.html : "";
        if (!html.trim()) return text("Refusing to publish: 'html' is required and must be non-empty.");
        const { url } = await deps.artifacts.publish(user, {
          html,
          ...(typeof args.title === "string" ? { title: args.title } : {}),
          ...(args.visibility === "private" || args.visibility === "authenticated"
            ? { visibility: args.visibility }
            : {}),
          ...(typeof args.expiresInSeconds === "number" ? { expiresInSeconds: args.expiresInSeconds } : {}),
        });
        return text(`Published. Share this login-gated URL:\n${url}`);
      },
    },
    {
      def: {
        name: "omni__list_artifacts",
        description: "List HTML artifacts you have published, with their URLs and status.",
        inputSchema: { type: "object", properties: {} },
      },
      handle: async (user) => {
        const metas = await deps.artifacts.list(user);
        const now = Date.now();
        return text(
          metas.map((m) => ({
            id: m.id,
            title: m.title,
            url: deps.artifacts.url(m.id),
            visibility: m.visibility,
            createdAt: m.createdAt,
            revoked: m.revokedAt !== null,
            expired: m.expiresAt !== null && m.expiresAt.getTime() <= now,
          })),
        );
      },
    },
    {
      def: {
        name: "omni__revoke_artifact",
        description: "Revoke a published artifact by id so its URL stops working.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "artifact id" } },
          required: ["id"],
        },
      },
      handle: async (user, args) => {
        const ok = await deps.artifacts.revoke(user, String(args.id ?? ""));
        return text(ok ? "Artifact revoked." : "Unknown artifact id (or not yours).");
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
