import { describe, it, expect } from "vitest";
import { jiraProvider } from "./index.js";
import type { RestClient } from "../../../ports/builtin.js";

const SITE = [{ id: "cloud-1", url: "https://okadoc.atlassian.net", name: "okadoc" }];
function http(routes: Record<string, unknown>, calls: any[] = []): RestClient {
  const find = (url: string) => Object.entries(routes).find(([k]) => url.includes(k))?.[1];
  return {
    get: async (url, init) => { calls.push(["GET", url, init]); return { status: 200, ok: true, body: find(url) ?? null }; },
    post: async (url, body) => { calls.push(["POST", url, body]); return { status: 200, ok: true, body: find(url) ?? { key: "OK-1" } }; },
  };
}
const tool = (name: string) => jiraProvider.tools.find((t) => t.def.name === name)!;

describe("jiraProvider", () => {
  it("exposes the five tools with the jira prefix binding", () => {
    expect(jiraProvider.id).toBe("atlassian");
    expect(jiraProvider.toolPrefix).toBe("jira");
    expect(jiraProvider.tools.map((t) => t.def.name).sort())
      .toEqual(["add_comment", "create_issue", "get_issue", "list_projects", "search"]);
  });

  it("search resolves cloudId then POSTs /search/jql with the JQL", async () => {
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE, "/search/jql": { issues: [{ key: "AB-1" }] } }, calls);
    const res = await tool("search").handle({ http: c }, { jql: "project=AB", maxResults: 10 });
    expect(calls[0][1]).toContain("accessible-resources");
    const searchCall = calls.find((k) => k[0] === "POST" && String(k[1]).endsWith("/ex/jira/cloud-1/rest/api/3/search/jql"));
    expect(searchCall).toBeTruthy();
    expect(searchCall[2].jql).toBe("project=AB");
    expect(searchCall[2].maxResults).toBe(10);
    expect(searchCall[2].fields).toEqual(
      expect.arrayContaining(["summary", "status", "assignee", "issuetype", "priority", "project", "created", "updated"]),
    );
    expect((res.content[0] as any).text).toContain("AB-1");
  });

  it("create_issue posts fields with an ADF description", async () => {
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE }, calls);
    await tool("create_issue").handle({ http: c }, { project: "AB", issueType: "Task", summary: "S", description: "hello" });
    const post = calls.find((k) => k[0] === "POST");
    expect(post[2].fields.project).toEqual({ key: "AB" });
    expect(post[2].fields.issuetype).toEqual({ name: "Task" });
    expect(post[2].fields.summary).toBe("S");
    expect(post[2].fields.description.type).toBe("doc");
  });

  it("surfaces the Jira error body instead of a generic message", async () => {
    const c: RestClient = {
      get: async (url) => url.includes("accessible-resources")
        ? { status: 200, ok: true, body: SITE }
        : { status: 400, ok: false, body: { errorMessages: ["Bad JQL"] } },
      post: async () => ({ status: 400, ok: false, body: { errorMessages: ["Bad JQL"] } }),
    };
    const res = await tool("search").handle({ http: c }, { jql: "!!!" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("Bad JQL");
  });
});
