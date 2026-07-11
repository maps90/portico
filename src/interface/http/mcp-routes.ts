import type { Express, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { TokenStore, User } from "../../ports/identity.js";
import { buildOmniServer, type OmniServerDeps } from "../mcp/omni-server.js";

export interface McpRouteDeps extends OmniServerDeps {
  tokens: TokenStore;
  baseUrl: string;
}

function bearer(req: Request): string | null {
  const h = req.header("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

async function authenticate(req: Request, tokens: TokenStore): Promise<User | null> {
  const raw = bearer(req);
  return raw ? tokens.resolve(raw) : null;
}

/**
 * The `/mcp` Streamable HTTP endpoint. Stateless: each request is authenticated
 * by bearer token, a fresh user-scoped MCP server is built and connected to a
 * one-shot transport, and both are torn down when the response ends. GET/DELETE
 * are not supported (no long-lived sessions).
 */
export function registerMcpRoute(app: Express, deps: McpRouteDeps): void {
  const unauthorized = (res: Response) => {
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer realm="omni-mcp", resource="${deps.baseUrl}/login"`)
      .json({
        jsonrpc: "2.0",
        error: { code: -32001, message: `Unauthorized. Sign in at ${deps.baseUrl}/login to get a token.` },
        id: null,
      });
  };

  app.post("/mcp", async (req: Request, res: Response) => {
    const user = await authenticate(req, deps.tokens);
    if (!user) {
      unauthorized(res);
      return;
    }

    const server = await buildOmniServer(user, deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("mcp request error", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server: use POST)." },
      id: null,
    });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
}
