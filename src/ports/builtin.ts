import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface RestResponse { status: number; ok: boolean; body: unknown; }
export interface RestInit {
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
}
export interface RestClient {
  get(url: string, init?: RestInit): Promise<RestResponse>;
  post(url: string, body: unknown, init?: RestInit): Promise<RestResponse>;
  /** Jira edits an issue with PUT, and answers 204 with an empty body. */
  put(url: string, body: unknown, init?: RestInit): Promise<RestResponse>;
}

/** Everything a builtin tool handler is given to do its work. */
export interface BuiltinCtx { http: RestClient; }

export interface BuiltinTool {
  /** MCP tool spec; `def.name` is UNPREFIXED (e.g. "search"). */
  def: Tool;
  handle(ctx: BuiltinCtx, args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface BuiltinProvider {
  /** Connection/upstream id whose OAuth token this provider uses (e.g. "atlassian"). */
  id: string;
  /** Tool-name prefix (e.g. "jira" → "jira__search"). */
  toolPrefix: string;
  tools: BuiltinTool[];
}
