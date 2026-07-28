import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BuiltinCtx, BuiltinProvider, BuiltinTool } from "../../../ports/builtin.js";

const ok = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});
const fail = (v: unknown): CallToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }], isError: true,
});
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

/** Resolve the Jira Cloud REST base for the token's first accessible site. */
async function jiraBase(ctx: BuiltinCtx): Promise<{ base: string } | { error: CallToolResult }> {
  const res = await ctx.http.get("https://api.atlassian.com/oauth/token/accessible-resources");
  if (!res.ok) return { error: fail(`Could not resolve Atlassian site (HTTP ${res.status}): ${JSON.stringify(res.body)}`) };
  const sites = Array.isArray(res.body) ? (res.body as Array<{ id: string; url: string }>) : [];
  if (sites.length === 0) return { error: fail("This Atlassian token has no accessible Jira sites.") };
  return { base: `https://api.atlassian.com/ex/jira/${sites[0]!.id}/rest/api/3` };
}
const adf = (text: string) => ({
  type: "doc", version: 1,
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
});

/**
 * What a search returns per issue unless the caller says otherwise. `creator` and
 * `reporter` earn their place: without them the only route to "who raised this" is
 * get_issue per ticket, which prices an org-wide breakdown at hundreds of calls.
 * Jira returns them in the same response for free.
 */
const SEARCH_FIELDS = [
  "summary", "status", "assignee", "creator", "reporter",
  "issuetype", "priority", "project", "created", "updated",
];

const strList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length > 0 ? v.map((x) => String(x)) : null;

const define = (def: Tool, run: (ctx: BuiltinCtx, base: string, a: Record<string, unknown>) => Promise<CallToolResult>): BuiltinTool => ({
  def,
  handle: async (ctx, a) => {
    const b = await jiraBase(ctx);
    if ("error" in b) return b.error;
    return run(ctx, b.base, a);
  },
});

export const jiraProvider: BuiltinProvider = {
  id: "atlassian",
  toolPrefix: "jira",
  tools: [
    define(
      { name: "search", description:
          "Search Jira issues with a JQL query. Returns ONE page. If the result carries " +
          "a nextPageToken, there are more issues -- pass it back as nextPageToken to " +
          "continue, and keep going until no token is returned. A count taken from a " +
          "single page is not a total.",
        inputSchema: {
        type: "object",
        properties: { jql: { type: "string", description: "JQL, e.g. project = AB AND status = Open" },
          maxResults: { type: "number", description: "page size, default 25" },
          fields: { type: "array", items: { type: "string" },
            description: "override the returned fields, e.g. [\"summary\",\"labels\"]" },
          nextPageToken: { type: "string", description: "token from a previous search result, to fetch the next page" } },
        required: ["jql"] } },
      async (ctx, base, a) => {
        const token = str(a.nextPageToken);
        const res = await ctx.http.post(`${base}/search/jql`, {
          jql: str(a.jql),
          maxResults: typeof a.maxResults === "number" ? a.maxResults : 25,
          fields: strList(a.fields) ?? SEARCH_FIELDS,
          // Omitted rather than sent empty: Jira reads a blank token as a bad cursor.
          ...(token ? { nextPageToken: token } : {}),
        });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    define(
      { name: "get_issue", description: "Get a Jira issue by key.", inputSchema: {
        type: "object", properties: { key: { type: "string", description: "issue key, e.g. AB-123" } }, required: ["key"] } },
      async (ctx, base, a) => {
        const res = await ctx.http.get(`${base}/issue/${encodeURIComponent(str(a.key))}`);
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    define(
      { name: "create_issue", description: "Create a Jira issue.", inputSchema: {
        type: "object",
        properties: { project: { type: "string", description: "project key" }, issueType: { type: "string", description: "e.g. Task, Bug" },
          summary: { type: "string" }, description: { type: "string", description: "optional plain text" } },
        required: ["project", "issueType", "summary"] } },
      async (ctx, base, a) => {
        const fields: Record<string, unknown> = {
          project: { key: str(a.project) }, issuetype: { name: str(a.issueType) }, summary: str(a.summary),
        };
        if (typeof a.description === "string" && a.description) fields.description = adf(a.description);
        const res = await ctx.http.post(`${base}/issue`, { fields });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    define(
      { name: "add_comment", description: "Add a comment to a Jira issue.", inputSchema: {
        type: "object", properties: { key: { type: "string" }, body: { type: "string" } }, required: ["key", "body"] } },
      async (ctx, base, a) => {
        const res = await ctx.http.post(`${base}/issue/${encodeURIComponent(str(a.key))}/comment`, { body: adf(str(a.body)) });
        return res.ok ? ok(res.body) : fail(res.body);
      }),
    define(
      { name: "list_projects", description: "List Jira projects visible to you.", inputSchema: { type: "object", properties: {} } },
      async (ctx, base) => {
        const res = await ctx.http.get(`${base}/project/search`);
        return res.ok ? ok(res.body) : fail(res.body);
      }),
  ],
};
