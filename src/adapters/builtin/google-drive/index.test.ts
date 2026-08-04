import { describe, it, expect } from "vitest";
import { googleDriveProvider } from "./index.js";
import type { RestClient } from "../../../ports/builtin.js";

function http(body: unknown, calls: any[] = []): RestClient {
  return {
    get: async (url, init) => { calls.push(["GET", url, init]); return { status: 200, ok: true, body }; },
    post: async (url, b) => { calls.push(["POST", url, b]); return { status: 200, ok: true, body }; },
    put: async (url, b) => { calls.push(["PUT", url, b]); return { status: 200, ok: true, body }; },
  };
}
const tool = (name: string) => googleDriveProvider.tools.find((t) => t.def.name === name)!;

describe("googleDriveProvider", () => {
  it("shares the google-drive connection but keeps its own gdrive prefix", () => {
    // Same connection id as googleDocsProvider on purpose: one Google OAuth
    // client, one consent, one token. Only the tool prefix separates them.
    expect(googleDriveProvider.id).toBe("google-drive");
    expect(googleDriveProvider.toolPrefix).toBe("gdrive");
    expect(googleDriveProvider.tools.map((t) => t.def.name).sort()).toEqual([
      "export_file", "get_file", "list_sheets", "read_presentation", "read_sheet", "search_files",
    ]);
  });

  it("search_files passes the caller's query through to Drive", async () => {
    const calls: any[] = [];
    await tool("search_files").handle({ http: http({ files: [] }, calls) }, { q: "name contains 'vpn'" });
    expect(calls[0][1]).toBe("https://www.googleapis.com/drive/v3/files");
    expect(calls[0][2].query.q).toBe("name contains 'vpn'");
    expect(calls[0][2].query.pageSize).toBe(25);
  });

  it("search_files asks for the fields needed to tell native files from uploads", async () => {
    const calls: any[] = [];
    await tool("search_files").handle({ http: http({ files: [] }, calls) }, {});
    expect(calls[0][2].query.fields).toContain("mimeType");
  });

  it("search_files keeps nextPageToken in the field mask so paging is possible", async () => {
    // A mask of files(...) alone strips Drive's own cursor, leaving nothing to
    // forward and making page one look like the entire result set.
    const calls: any[] = [];
    await tool("search_files").handle({ http: http({ files: [] }, calls) }, {});
    expect(calls[0][2].query.fields).toContain("nextPageToken");
  });

  it("search_files forwards a cursor, and omits it when absent", async () => {
    const calls: any[] = [];
    await tool("search_files").handle({ http: http({ files: [] }, calls) }, { pageToken: "CURSOR" });
    expect(calls[0][2].query.pageToken).toBe("CURSOR");

    const bare: any[] = [];
    await tool("search_files").handle({ http: http({ files: [] }, bare) }, {});
    // Drive rejects a blank cursor, so it must be absent rather than "".
    expect("pageToken" in bare[0][2].query).toBe(false);
  });

  it("get_file requests metadata for one id", async () => {
    const calls: any[] = [];
    await tool("get_file").handle({ http: http({ id: "f1" }, calls) }, { fileId: "f1" });
    expect(calls[0][1]).toBe("https://www.googleapis.com/drive/v3/files/f1");
  });

  it("export_file exports a native Google file at the requested mime type", async () => {
    const calls: any[] = [];
    await tool("export_file").handle({ http: http("a,b\n1,2", calls) }, {
      fileId: "s1", mimeType: "text/csv",
    });
    expect(calls[0][1]).toBe("https://www.googleapis.com/drive/v3/files/s1/export");
    expect(calls[0][2].query.mimeType).toBe("text/csv");
  });

  it("export_file defaults to plain text when no mime type is given", async () => {
    const calls: any[] = [];
    await tool("export_file").handle({ http: http("hello", calls) }, { fileId: "d1" });
    expect(calls[0][2].query.mimeType).toBe("text/plain");
  });

  it("list_sheets asks the Sheets API only for tab properties", async () => {
    const calls: any[] = [];
    await tool("list_sheets").handle({ http: http({ sheets: [] }, calls) }, { spreadsheetId: "s1" });
    expect(calls[0][1]).toBe("https://sheets.googleapis.com/v4/spreadsheets/s1");
    expect(calls[0][2].query.fields).toBe("sheets.properties");
  });

  it("read_sheet reads a named range from the Sheets API", async () => {
    const calls: any[] = [];
    await tool("read_sheet").handle({ http: http({ values: [] }, calls) }, {
      spreadsheetId: "s1", range: "Config!A1:D50",
    });
    expect(calls[0][1]).toBe("https://sheets.googleapis.com/v4/spreadsheets/s1/values/Config!A1%3AD50");
  });

  it("read_presentation fetches the deck from the Slides API", async () => {
    const calls: any[] = [];
    await tool("read_presentation").handle({ http: http({ slides: [] }, calls) }, { presentationId: "p1" });
    expect(calls[0][1]).toBe("https://slides.googleapis.com/v1/presentations/p1");
  });

  const DECK = {
    title: "Q3 Review",
    slides: [
      {
        pageElements: [
          { shape: { text: { textElements: [{ textRun: { content: "Revenue is up\n" } }] } } },
          { elementGroup: { children: [
            { shape: { text: { textElements: [{ textRun: { content: "grouped detail\n" } }] } } },
          ] } },
        ],
        slideProperties: { notesPage: { pageElements: [
          { shape: { text: { textElements: [{ textRun: { content: "Pause here." } }] } } },
        ] } },
      },
    ],
  };

  it("read_presentation returns slide text, not the raw Slides structure", async () => {
    const res = await tool("read_presentation").handle({ http: http(DECK) }, { presentationId: "p1" });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("Q3 Review");
    expect(text).toContain("Slide 1 of 1");
    expect(text).toContain("Revenue is up");
    // A grouped shape's text is dropped by a non-recursive walk, which reads as an
    // empty slide rather than as a parser that gave up.
    expect(text).toContain("grouped detail");
    expect(text).toContain("Pause here.");
    expect(text).not.toContain("textRun");
  });

  it("read_presentation still gives the full structure on request", async () => {
    const res = await tool("read_presentation").handle(
      { http: http(DECK) }, { presentationId: "p1", format: "json" });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("textRun");
  });

  it("surfaces upstream failures as tool errors rather than silent success", async () => {
    const failing: RestClient = {
      get: async () => ({ status: 403, ok: false, body: { error: "insufficient scope" } }),
      post: async () => ({ status: 403, ok: false, body: {} }),
      put: async () => ({ status: 403, ok: false, body: {} }),
    };
    const res = await tool("read_sheet").handle({ http: failing }, { spreadsheetId: "s1", range: "A1" });
    expect(res.isError).toBe(true);
  });
});
