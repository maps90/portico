import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BuiltinCtx, BuiltinProvider, BuiltinTool } from "../../../ports/builtin.js";

const ok = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});
const fail = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], isError: true,
});
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const DOCS = "https://docs.googleapis.com/v1/documents";

const t = (def: Tool, handle: BuiltinTool["handle"]): BuiltinTool => ({ def, handle });

export const googleDocsProvider: BuiltinProvider = {
  id: "google-docs",
  toolPrefix: "gdocs",
  tools: [
    t({ name: "create_document", description: "Create a new Google Doc.", inputSchema: {
        type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
      async (ctx, a) => {
        const res = await ctx.http.post(DOCS, { title: str(a.title) });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    t({ name: "get_document", description: "Fetch a Google Doc's content by id.", inputSchema: {
        type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"] } },
      async (ctx, a) => {
        const res = await ctx.http.get(`${DOCS}/${encodeURIComponent(str(a.documentId))}`);
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    t({ name: "append_text", description: "Append text to the end of a Google Doc.", inputSchema: {
        type: "object", properties: { documentId: { type: "string" }, text: { type: "string" } },
        required: ["documentId", "text"] } },
      async (ctx, a) => {
        const res = await ctx.http.post(`${DOCS}/${encodeURIComponent(str(a.documentId))}:batchUpdate`, {
          requests: [{ insertText: { endOfSegmentLocation: {}, text: str(a.text) } }],
        });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    t({ name: "list_documents", description: "List Google Docs this app can see.", inputSchema: {
        type: "object", properties: { pageSize: { type: "number", description: "default 25" } } } },
      async (ctx, a) => {
        const res = await ctx.http.get("https://www.googleapis.com/drive/v3/files", {
          query: {
            q: "mimeType='application/vnd.google-apps.document'",
            pageSize: typeof a.pageSize === "number" ? a.pageSize : 25,
            fields: "files(id,name,modifiedTime)",
          },
        });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
  ],
};
