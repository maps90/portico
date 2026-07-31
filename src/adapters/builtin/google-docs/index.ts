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

/**
 * What every tool here can and cannot see. `drive.file` is per-file access: the
 * grant covers documents this app created or the user explicitly picked for it,
 * and nothing else. Said in each tool description because the tool description is
 * the only thing the calling agent reads -- without it, a pasted document id 404s
 * and the honest report back is "Google Docs is broken" rather than "not shared
 * with this app". Widening it is a consent decision (drive.readonly), not a code one.
 */
const SCOPE_NOTE =
  "Limited to documents created through this tool (the drive.file scope): a " +
  "document made elsewhere is invisible here even if you can open it in a browser.";

type Node = Record<string, unknown>;
const nodes = (v: unknown): Node[] => (Array.isArray(v) ? (v as Node[]) : []);
const node = (v: unknown): Node => (v !== null && typeof v === "object" ? (v as Node) : {});

/**
 * The readable text of a Docs document.
 *
 * A document is one object per *style run*, not per paragraph, so the raw JSON for
 * a page of prose is tens of thousands of tokens -- spent out of the caller's
 * context to say very little. Tables are walked rather than skipped: their cells
 * hold ordinary paragraphs, and dropping them loses content silently, which is
 * worse than returning nothing.
 */
const documentText = (doc: unknown): string => {
  const out: string[] = [];
  const walk = (content: unknown): void => {
    for (const el of nodes(content)) {
      for (const e of nodes(node(el.paragraph).elements)) {
        const run = node(node(e).textRun).content;
        if (typeof run === "string") out.push(run);
      }
      for (const row of nodes(node(el.table).tableRows)) {
        for (const cell of nodes(node(row).tableCells)) walk(node(cell).content);
      }
      walk(node(el.tableOfContents).content);
    }
  };
  const d = node(doc);
  walk(node(d.body).content);
  const body = out.join("").replace(/\n{3,}/g, "\n\n").trimEnd();
  return typeof d.title === "string" && d.title ? `${d.title}\n\n${body}` : body;
};

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
    t({ name: "get_document", description:
        "Read a Google Doc by id. Returns the document's text by default. " +
        "Pass format: \"json\" only when you need the Docs API structure (element " +
        "indexes for editing) -- it is far larger. " + SCOPE_NOTE, inputSchema: {
        type: "object", properties: { documentId: { type: "string" },
          format: { type: "string", enum: ["text", "json"], description: "default text" } },
        required: ["documentId"] } },
      async (ctx, a) => {
        const res = await ctx.http.get(`${DOCS}/${encodeURIComponent(str(a.documentId))}`);
        if (!res.ok) return fail(res.body);
        return ok(str(a.format) === "json" ? res.body : documentText(res.body));
      }),
    t({ name: "append_text", description:
        "Append text to the end of a Google Doc. " + SCOPE_NOTE, inputSchema: {
        type: "object", properties: { documentId: { type: "string" }, text: { type: "string" } },
        required: ["documentId", "text"] } },
      async (ctx, a) => {
        const res = await ctx.http.post(`${DOCS}/${encodeURIComponent(str(a.documentId))}:batchUpdate`, {
          requests: [{ insertText: { endOfSegmentLocation: {}, text: str(a.text) } }],
        });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    t({ name: "list_documents", description:
        "List Google Docs, ONE page at a time. If the result carries a " +
        "nextPageToken, there are more documents -- pass it back as pageToken and " +
        "keep going until no token is returned. A count taken from a single page " +
        "is not a total. " + SCOPE_NOTE, inputSchema: {
        type: "object", properties: { pageSize: { type: "number", description: "default 25" },
          pageToken: { type: "string", description: "token from a previous result, to fetch the next page" } } } },
      async (ctx, a) => {
        const token = str(a.pageToken);
        const res = await ctx.http.get("https://www.googleapis.com/drive/v3/files", {
          query: {
            q: "mimeType='application/vnd.google-apps.document'",
            pageSize: typeof a.pageSize === "number" ? a.pageSize : 25,
            // nextPageToken must be named here. `fields` is a response mask, so a
            // mask of files(...) alone drops Drive's own paging token -- leaving
            // nothing to forward and making page one look like the whole set.
            fields: "nextPageToken,files(id,name,modifiedTime)",
            // Omitted rather than sent empty: Drive rejects a blank cursor.
            ...(token ? { pageToken: token } : {}),
          },
        });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
  ],
};
