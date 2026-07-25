import { describe, it, expect } from "vitest";
import { Registry, type UpstreamEntry } from "./upstream.js";

const entry = (over: Partial<UpstreamEntry>): UpstreamEntry => ({
  id: "x", displayName: "X", mcpUrl: "", toolPrefix: "x", kind: "proxied",
  oauth: { authorizationUrl: "a", tokenUrl: "t", scopes: [], clientId: "", clientSecret: "" },
  ...over,
});

describe("Registry.isConfigured builtin", () => {
  it("is true for a builtin with creds and no mcpUrl", () => {
    const r = new Registry(new Map([["g", entry({ id: "g", kind: "builtin",
      oauth: { authorizationUrl: "a", tokenUrl: "t", scopes: [], clientId: "c", clientSecret: "s" } })]]));
    expect(r.isConfigured("g")).toBe(true);
  });
  it("is false for a builtin missing creds", () => {
    const r = new Registry(new Map([["g", entry({ id: "g", kind: "builtin" })]]));
    expect(r.isConfigured("g")).toBe(false);
  });
  it("still requires mcpUrl for a proxied upstream", () => {
    const r = new Registry(new Map([["p", entry({ id: "p", kind: "proxied",
      oauth: { authorizationUrl: "a", tokenUrl: "t", scopes: [], clientId: "c", clientSecret: "s" } })]]));
    expect(r.isConfigured("p")).toBe(false); // mcpUrl empty
  });
});
