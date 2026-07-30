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
  it("binds to the google-docs connection with the gdocs prefix", () => {
    expect(googleDocsProvider.id).toBe("google-docs");
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
});
