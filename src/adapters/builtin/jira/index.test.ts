import { describe, it, expect } from "vitest";
import { jiraProvider } from "./index.js";
import type { RestClient } from "../../../ports/builtin.js";

const SITE = [{ id: "cloud-1", url: "https://okadoc.atlassian.net", name: "okadoc" }];
function http(routes: Record<string, unknown>, calls: any[] = []): RestClient {
  const find = (url: string) => Object.entries(routes).find(([k]) => url.includes(k))?.[1];
  return {
    get: async (url, init) => { calls.push(["GET", url, init]); return { status: 200, ok: true, body: find(url) ?? null }; },
    post: async (url, body) => { calls.push(["POST", url, body]); return { status: 200, ok: true, body: find(url) ?? { key: "OK-1" } }; },
    // Jira answers a successful PUT /issue/{key} with 204 and an empty body.
    put: async (url, body) => { calls.push(["PUT", url, body]); return { status: 204, ok: true, body: null }; },
  };
}
const tool = (name: string) => jiraProvider.tools.find((t) => t.def.name === name)!;

describe("jiraProvider", () => {
  it("exposes the six tools with the jira prefix binding", () => {
    expect(jiraProvider.id).toBe("atlassian");
    expect(jiraProvider.toolPrefix).toBe("jira");
    expect(jiraProvider.tools.map((t) => t.def.name).sort())
      .toEqual(["add_comment", "create_issue", "edit_issue", "get_issue", "list_projects", "search"]);
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

  it("search asks for creator and reporter, so attribution costs no extra call", async () => {
    // Without these in the default set the only route to "who raised this" is
    // get_issue per ticket -- an agent asked for an org-wide breakdown priced it
    // at 300-500 calls. Jira returns them in the same search response for free.
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE, "/search/jql": { issues: [] } }, calls);
    await tool("search").handle({ http: c }, { jql: "project=AB" });
    const searchCall = calls.find((k) => k[0] === "POST");
    expect(searchCall[2].fields).toEqual(expect.arrayContaining(["creator", "reporter"]));
  });

  it("search lets the caller override the field set", async () => {
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE, "/search/jql": { issues: [] } }, calls);
    await tool("search").handle({ http: c }, { jql: "project=AB", fields: ["summary", "labels"] });
    const searchCall = calls.find((k) => k[0] === "POST");
    expect(searchCall[2].fields).toEqual(["summary", "labels"]);
  });

  it("search forwards nextPageToken so results past the first page are reachable", async () => {
    // /search/jql is token-paginated. With no way to send the token back, any
    // query matching more than one page returned the first page and stopped --
    // a short answer that looks complete.
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE, "/search/jql": { issues: [] } }, calls);
    await tool("search").handle({ http: c }, { jql: "project=AB", nextPageToken: "tok-2" });
    const searchCall = calls.find((k) => k[0] === "POST");
    expect(searchCall[2].nextPageToken).toBe("tok-2");
  });

  it("search omits nextPageToken on a first page rather than sending an empty one", async () => {
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE, "/search/jql": { issues: [] } }, calls);
    await tool("search").handle({ http: c }, { jql: "project=AB" });
    const searchCall = calls.find((k) => k[0] === "POST");
    expect("nextPageToken" in searchCall[2]).toBe(false);
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

  it("create_issue parents the new issue when given a parent key", async () => {
    // Without this the parent argument was accepted and silently dropped: Jira
    // returned 201 and the issue landed outside the epic, so "add a child to
    // this epic" reported success and did nothing.
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE }, calls);
    await tool("create_issue").handle({ http: c },
      { project: "AB", issueType: "Story", summary: "S", parent: "AB-9" });
    const post = calls.find((k) => k[0] === "POST");
    expect(post[2].fields.parent).toEqual({ key: "AB-9" });
  });

  it("create_issue omits parent entirely when none is given", async () => {
    // `parent: {key: ""}` is not "no parent" to Jira, it is a 400.
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE }, calls);
    await tool("create_issue").handle({ http: c }, { project: "AB", issueType: "Task", summary: "S" });
    const post = calls.find((k) => k[0] === "POST");
    expect("parent" in post[2].fields).toBe(false);
  });

  it("edit_issue PUTs the parent so an existing issue can join an epic", async () => {
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE }, calls);
    await tool("edit_issue").handle({ http: c }, { key: "AB-1", parent: "AB-9" });
    const put = calls.find((k) => k[0] === "PUT");
    expect(String(put[1])).toContain("/ex/jira/cloud-1/rest/api/3/issue/AB-1");
    expect(put[2].fields.parent).toEqual({ key: "AB-9" });
  });

  it("edit_issue clears the parent when parent is null", async () => {
    // Jira's documented way to orphan an issue. Distinct from "parent omitted",
    // which must leave the existing parent alone.
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE }, calls);
    await tool("edit_issue").handle({ http: c }, { key: "AB-1", parent: null });
    const put = calls.find((k) => k[0] === "PUT");
    expect(put[2].fields.parent).toBe(null);
  });

  it("edit_issue merges a raw fields object, so custom fields need no new param", async () => {
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE }, calls);
    await tool("edit_issue").handle({ http: c },
      { key: "AB-1", summary: "new", fields: { customfield_10117: 5 } });
    const put = calls.find((k) => k[0] === "PUT");
    expect(put[2].fields.summary).toBe("new");
    expect(put[2].fields.customfield_10117).toBe(5);
  });

  it("edit_issue refuses a call with nothing to change instead of PUTting an empty edit", async () => {
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE }, calls);
    const res = await tool("edit_issue").handle({ http: c }, { key: "AB-1" });
    expect(res.isError).toBe(true);
    expect(calls.some((k) => k[0] === "PUT")).toBe(false);
  });

  it("edit_issue reports success on Jira's empty 204 body", async () => {
    // ok(null) renders the string "null", which reads as a failure to an agent.
    const c = http({ "accessible-resources": SITE });
    const res = await tool("edit_issue").handle({ http: c }, { key: "AB-1", parent: "AB-9" });
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as any).text).toContain("AB-1");
  });

  it("list_projects asks for a full page and reports where it stopped", async () => {
    // /project/search caps a page at 50. Sending nothing took Jira's default and
    // returned 50 of the site's 107 projects with no sign there were more, so an
    // agent could not see -- or file anything into -- project 51 onward.
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE, "/project/search": { values: [], isLast: false, total: 107 } }, calls);
    await tool("list_projects").handle({ http: c }, {});
    const get = calls.find((k) => k[0] === "GET" && String(k[1]).includes("/project/search"));
    expect(get[2].query.maxResults).toBe(50);
    expect(get[2].query.startAt).toBe(0);
  });

  it("list_projects pages with startAt so projects past the first page are reachable", async () => {
    const calls: any[] = [];
    const c = http({ "accessible-resources": SITE, "/project/search": { values: [], isLast: true } }, calls);
    await tool("list_projects").handle({ http: c }, { startAt: 50 });
    const get = calls.find((k) => k[0] === "GET" && String(k[1]).includes("/project/search"));
    expect(get[2].query.startAt).toBe(50);
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
