import { describe, it, expect } from "vitest";
import { googleDocsProvider } from "./index.js";
import type { RestClient } from "../../../ports/builtin.js";

function http(body: unknown, calls: any[] = []): RestClient {
  return {
    get: async (url, init) => { calls.push(["GET", url, init]); return { status: 200, ok: true, body }; },
    post: async (url, b) => { calls.push(["POST", url, b]); return { status: 200, ok: true, body }; },
    put: async (url, b) => { calls.push(["PUT", url, b]); return { status: 200, ok: true, body }; },
  };
}
const tool = (name: string) => googleDocsProvider.tools.find((t) => t.def.name === name)!;

describe("googleDocsProvider", () => {
  it("binds to the google-drive connection with the gdocs prefix", () => {
    expect(googleDocsProvider.id).toBe("google-drive");
    expect(googleDocsProvider.toolPrefix).toBe("gdocs");
    expect(googleDocsProvider.tools.map((t) => t.def.name).sort())
      .toEqual(["append_text", "create_document", "get_document", "list_documents"]);
  });

  it("create_document posts a title to the Docs API", async () => {
    const calls: any[] = [];
    await tool("create_document").handle({ http: http({ documentId: "d1" }, calls) }, { title: "Notes" });
    expect(calls[0][1]).toBe("https://docs.googleapis.com/v1/documents");
    expect(calls[0][2]).toEqual({ title: "Notes" });
  });

  it("append_text sends a batchUpdate insertText at end of segment", async () => {
    const calls: any[] = [];
    await tool("append_text").handle({ http: http({}, calls) }, { documentId: "d1", text: "hi" });
    expect(calls[0][1]).toBe("https://docs.googleapis.com/v1/documents/d1:batchUpdate");
    expect(calls[0][2].requests[0].insertText).toEqual({ endOfSegmentLocation: {}, text: "hi" });
  });

  it("list_documents queries Drive for Google Doc files", async () => {
    const calls: any[] = [];
    await tool("list_documents").handle({ http: http({ files: [] }, calls) }, {});
    expect(calls[0][1]).toBe("https://www.googleapis.com/drive/v3/files");
    expect(calls[0][2].query.q).toBe("mimeType='application/vnd.google-apps.document'");
  });

  it("list_documents asks Drive for nextPageToken, which the fields mask otherwise strips", async () => {
    // The mask is the whole bug: Drive does return a nextPageToken, but a `fields`
    // of files(...) alone drops it from the response, so there was no token to
    // forward even in principle -- page one always looked like the whole set.
    const calls: any[] = [];
    await tool("list_documents").handle({ http: http({ files: [] }, calls) }, {});
    expect(calls[0][2].query.fields).toContain("nextPageToken");
  });

  it("list_documents forwards a pageToken so results past the first page are reachable", async () => {
    const calls: any[] = [];
    await tool("list_documents").handle({ http: http({ files: [] }, calls) }, { pageToken: "tok-2" });
    expect(calls[0][2].query.pageToken).toBe("tok-2");
  });

  it("list_documents omits pageToken on a first page rather than sending an empty one", async () => {
    const calls: any[] = [];
    await tool("list_documents").handle({ http: http({ files: [] }, calls) }, {});
    expect(calls[0][2].query.pageToken).toBeUndefined();
  });

  const DOC = {
    title: "Design",
    body: {
      content: [
        { paragraph: { elements: [{ textRun: { content: "Hello " } }, { textRun: { content: "world\n" } }] } },
        { table: { tableRows: [{ tableCells: [
          { content: [{ paragraph: { elements: [{ textRun: { content: "cell\n" } }] } }] },
        ] }] } },
      ],
    },
  };

  it("get_document returns readable text, not the raw Docs JSON", async () => {
    // A Docs document is one object per style run. Returning it whole spends tens
    // of thousands of tokens of the caller's context to say "Hello world".
    const res = await tool("get_document").handle({ http: http(DOC) }, { documentId: "d1" });
    const text = (res.content[0] as any).text;
    expect(text).toContain("Hello world");
    expect(text).not.toContain("textRun");
  });

  it("get_document pulls text out of tables too, so table content is not silently dropped", async () => {
    const res = await tool("get_document").handle({ http: http(DOC) }, { documentId: "d1" });
    expect((res.content[0] as any).text).toContain("cell");
  });

  it("get_document still returns the full structure on format: json", async () => {
    // Structural edits need the real element indexes; text mode cannot serve them.
    const res = await tool("get_document").handle({ http: http(DOC) }, { documentId: "d1", format: "json" });
    expect((res.content[0] as any).text).toContain("textRun");
  });

  it("get_document surfaces an API error rather than extracting text from it", async () => {
    const c: RestClient = {
      get: async () => ({ status: 404, ok: false, body: { error: { message: "File not found: d9." } } }),
      post: async () => ({ status: 200, ok: true, body: null }),
      put: async () => ({ status: 200, ok: true, body: null }),
    };
    const res = await tool("get_document").handle({ http: c }, { documentId: "d9" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("File not found");
  });
});
