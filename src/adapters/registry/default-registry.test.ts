import { describe, it, expect } from "vitest";
import { buildRegistry } from "./default-registry.js";

describe("atlassian scopes", () => {
  const atlassian = (env: Record<string, string | undefined> = {}) =>
    buildRegistry(env).get("atlassian")!;

  it("asks for read:me, or every tool call fails", () => {
    // The bug this test exists for. Without read:me, Atlassian happily *lists* all
    // 40 tools -- listing needs no permission -- and then refuses to *execute* any
    // of them, including `atlassianUserInfo`, which takes no arguments and maps
    // straight to /me. The refusal arrives as Atlassian's generic
    // "We are having trouble completing this action. Please try again shortly.",
    // which names nothing and sent us hunting through jean and the gateway first.
    expect(atlassian().oauth.scopes).toContain("read:me");
  });

  it("asks for offline_access, so a token can be refreshed", () => {
    expect(atlassian().oauth.scopes).toContain("offline_access");
  });

  it("stays on one Confluence scope dialect -- classic, all of it", () => {
    // Classic, because that is what a classic app is offered: granular scopes
    // (read:page:confluence, ...) do not appear on developer.atlassian.com for
    // this app at all. An app cannot mix the two dialects, so a lone granular
    // entry here would be a scope nobody can grant.
    const { scopes } = atlassian().oauth;
    expect(scopes).toContain("read:confluence-content.all");
    expect(scopes).toContain("write:confluence-content");
    expect(scopes.filter((s) => s.endsWith(":confluence") && s.includes(":page"))).toEqual([]);
  });

  it("can read and write Jira work", () => {
    const { scopes } = atlassian().oauth;
    expect(scopes).toContain("read:jira-work");
    expect(scopes).toContain("write:jira-work");
  });

  it("lets ops override the scope list without a redeploy", () => {
    // Atlassian does not document the scope set its MCP server requires -- neither
    // the support site nor the official repo enumerates it -- so getting it exactly
    // right may take a round or two. Every attempt otherwise costs a code change,
    // a build, and a deploy. Same env-per-upstream convention as MCP_URL and the
    // client credentials.
    const entry = atlassian({
      PORTICO_UPSTREAM_ATLASSIAN_SCOPES: "read:me offline_access read:jira-work",
    });

    expect(entry.oauth.scopes).toEqual(["read:me", "offline_access", "read:jira-work"]);
  });

  it("ignores a blank override rather than asking for no scopes at all", () => {
    // An env var set to "" is an ops accident, not a request for zero scopes --
    // and zero scopes is the failure we are here to fix.
    expect(atlassian({ PORTICO_UPSTREAM_ATLASSIAN_SCOPES: "   " }).oauth.scopes).toContain(
      "read:me",
    );
  });
});
