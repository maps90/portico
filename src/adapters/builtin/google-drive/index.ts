import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BuiltinCtx, BuiltinProvider, BuiltinTool } from "../../../ports/builtin.js";

const ok = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});
const fail = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], isError: true,
});
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const SLIDES = "https://slides.googleapis.com/v1/presentations";

const t = (def: Tool, handle: BuiltinTool["handle"]): BuiltinTool => ({ def, handle });

type Node = Record<string, unknown>;
const nodes = (v: unknown): Node[] => (Array.isArray(v) ? (v as Node[]) : []);
const node = (v: unknown): Node => (v !== null && typeof v === "object" ? (v as Node) : {});

/**
 * The readable text of a Slides deck, slide by slide.
 *
 * Same reason get_document stopped returning raw Docs JSON: a presentation carries
 * geometry, transforms and styling for every element, so the raw structure is
 * enormous next to the words on the slides. Groups are walked recursively -- a
 * grouped shape's text is otherwise dropped silently, which reads as an empty
 * slide rather than as a parser that gave up.
 *
 * Speaker notes are included because they routinely carry the argument the slide
 * only gestures at, and a reader asking "what does this deck say" wants them.
 */
const presentationText = (deck: unknown): string => {
  const textOf = (el: unknown): string => {
    const out: string[] = [];
    const walk = (e: unknown): void => {
      const n = node(e);
      for (const te of nodes(node(node(n.shape).text).textElements)) {
        const run = node(node(te).textRun).content;
        if (typeof run === "string") out.push(run);
      }
      for (const row of nodes(node(n.table).tableRows)) {
        for (const cell of nodes(node(row).tableCells)) {
          for (const te of nodes(node(node(cell).text).textElements)) {
            const run = node(node(te).textRun).content;
            if (typeof run === "string") out.push(run);
          }
        }
      }
      for (const child of nodes(node(n.elementGroup).children)) walk(child);
    };
    walk(el);
    return out.join("");
  };

  const d = node(deck);
  const slides = nodes(d.slides);
  const parts: string[] = [];
  slides.forEach((slide, i) => {
    const body = nodes(node(slide).pageElements).map(textOf).join("").trimEnd();
    const notes = nodes(node(node(node(slide).slideProperties).notesPage).pageElements)
      .map(textOf).join("").trim();
    parts.push(
      `# Slide ${i + 1} of ${slides.length}\n\n${body}` +
      (notes ? `\n\n[speaker notes] ${notes}` : ""),
    );
  });
  const text = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  return typeof d.title === "string" && d.title ? `${d.title}\n\n${text}` : text;
};

/**
 * Read-only Drive, Sheets and Slides on the `google-drive` connection, shared with
 * googleDocsProvider — one Google OAuth client, one consent, one stored token.
 * A provider binds to a connection id, not to an upstream of its own (jiraProvider
 * does the same on `atlassian`), so the split here is only the tool prefix:
 * `gdrive__*` reads, `gdocs__*` writes documents.
 *
 * Sharing the connection is the point: both providers call Google with the same
 * user's token, and list_documents was already a Drive API call. A second
 * connection would have meant a second consent screen and a second token for the
 * same Google account, to reach the same APIs.
 *
 * Three API surfaces are still needed, because Drive alone cannot read a Sheet
 * properly: `files/{id}/export` renders only the FIRST tab of a spreadsheet, so a
 * workbook whose data lives on tab three exports the wrong content and still
 * returns 200. list_sheets/read_sheet go to the Sheets API, which addresses tabs
 * by name; Slides gets its own call for the same reason.
 */
export const googleDriveProvider: BuiltinProvider = {
  id: "google-drive",
  toolPrefix: "gdrive",
  tools: [
    t({ name: "search_files", description:
        "Search Drive files with a Drive v3 query, e.g. \"name contains 'vpn'\" or " +
        "\"mimeType='application/vnd.google-apps.spreadsheet'\". Returns ONE page at " +
        "a time. If the result carries a nextPageToken there are more files — pass it " +
        "back as pageToken and keep going until no token is returned. A count taken " +
        "from a single page is not a total.", inputSchema: {
        type: "object", properties: {
          q: { type: "string", description: "Drive v3 query; omit to list recent files" },
          pageSize: { type: "number", description: "default 25" },
          pageToken: { type: "string", description: "token from a previous result, to fetch the next page" },
        } } },
      async (ctx, a) => {
        const token = str(a.pageToken);
        const res = await ctx.http.get(DRIVE, {
          query: {
            ...(str(a.q) ? { q: str(a.q) } : {}),
            pageSize: typeof a.pageSize === "number" ? a.pageSize : 25,
            // nextPageToken must be named here. `fields` is a response mask, so a mask
            // of files(...) alone drops Drive's own paging token -- leaving nothing to
            // forward and making page one look like the whole set.
            //
            // mimeType is load-bearing for the caller, not decoration: it is the only
            // way to tell a native Sheet (exportable) from an uploaded .xlsx (not
            // exportable, must be downloaded), which decides which tool comes next.
            fields: "nextPageToken,files(id,name,mimeType,modifiedTime,owners(emailAddress))",
            // Omitted rather than sent empty: Drive rejects a blank cursor.
            ...(token ? { pageToken: token } : {}),
          },
        });
        return res.ok ? ok(res.body) : fail(res.body);
      }),

    t({ name: "get_file", description: "Fetch one Drive file's metadata by id.", inputSchema: {
        type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] } },
      async (ctx, a) => {
        const res = await ctx.http.get(`${DRIVE}/${encodeURIComponent(str(a.fileId))}`, {
          query: { fields: "id,name,mimeType,modifiedTime,size,owners(emailAddress)" },
        });
        return res.ok ? ok(res.body) : fail(res.body);
      }),

    t({ name: "export_file", description:
        "Export a native Google file as text — Docs/Slides as text/plain, Sheets as text/csv " +
        "(first tab only; use read_sheet for a specific tab). Uploaded .xlsx/.pptx cannot be " +
        "exported this way.", inputSchema: {
        type: "object", properties: {
          fileId: { type: "string" },
          mimeType: { type: "string", description: "target type; default text/plain" },
        }, required: ["fileId"] } },
      async (ctx, a) => {
        const res = await ctx.http.get(`${DRIVE}/${encodeURIComponent(str(a.fileId))}/export`, {
          query: { mimeType: str(a.mimeType, "text/plain") },
        });
        return res.ok ? ok(res.body) : fail(res.body);
      }),

    t({ name: "list_sheets", description:
        "List a spreadsheet's tabs (title, sheetId/gid, dimensions) so read_sheet can name one.",
        inputSchema: {
        type: "object", properties: { spreadsheetId: { type: "string" } },
        required: ["spreadsheetId"] } },
      async (ctx, a) => {
        const res = await ctx.http.get(`${SHEETS}/${encodeURIComponent(str(a.spreadsheetId))}`, {
          // Without this the API returns the entire workbook including every cell.
          query: { fields: "sheets.properties" },
        });
        return res.ok ? ok(res.body) : fail(res.body);
      }),

    t({ name: "read_sheet", description:
        "Read cell values from a spreadsheet range in A1 notation, e.g. 'Config!A1:D50' or " +
        "a bare tab name for the whole tab.", inputSchema: {
        type: "object", properties: {
          spreadsheetId: { type: "string" },
          range: { type: "string", description: "A1 notation; a bare tab name reads that whole tab" },
        }, required: ["spreadsheetId", "range"] } },
      async (ctx, a) => {
        const res = await ctx.http.get(
          `${SHEETS}/${encodeURIComponent(str(a.spreadsheetId))}` +
          `/values/${encodeURIComponent(str(a.range))}`,
        );
        return res.ok ? ok(res.body) : fail(res.body);
      }),

    t({ name: "read_presentation", description:
        "Read a Google Slides deck by id. Returns the deck's text, slide by slide. " +
        "Pass format: \"json\" only when you need the Slides API structure (element " +
        "ids and geometry) -- it is far larger.", inputSchema: {
        type: "object", properties: { presentationId: { type: "string" },
          format: { type: "string", enum: ["text", "json"], description: "default text" } },
        required: ["presentationId"] } },
      async (ctx, a) => {
        const res = await ctx.http.get(`${SLIDES}/${encodeURIComponent(str(a.presentationId))}`);
        if (!res.ok) return fail(res.body);
        return ok(str(a.format) === "json" ? res.body : presentationText(res.body));
      }),
  ],
};
