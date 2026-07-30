import { describe, it, expect } from "vitest";
import { bearerRestClient } from "./rest-client.js";

const fakeFetch = (captured: { url?: string; init?: RequestInit }) =>
  (async (url: string, init?: RequestInit) => {
    captured.url = url; captured.init = init;
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;

describe("bearerRestClient", () => {
  it("attaches the bearer token and appends query params", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const c = bearerRestClient("tok", fakeFetch(cap));
    const res = await c.get("https://api.example.com/x", { query: { a: "1", b: 2 } });
    expect(cap.url).toBe("https://api.example.com/x?a=1&b=2");
    expect((cap.init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(res).toEqual({ status: 200, ok: true, body: { ok: 1 } });
  });

  it("post sends a JSON body with content-type and surfaces non-2xx bodies", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const errFetch = (async (url: string, init?: RequestInit) => {
      cap.url = url; cap.init = init;
      return new Response(JSON.stringify({ error: "bad" }), { status: 400 });
    }) as unknown as typeof fetch;
    const c = bearerRestClient("tok", errFetch);
    const res = await c.post("https://api.example.com/x", { name: "n" });
    expect(cap.init!.method).toBe("POST");
    expect(cap.init!.body).toBe(JSON.stringify({ name: "n" }));
    expect((cap.init!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(res).toEqual({ status: 400, ok: false, body: { error: "bad" } });
  });

  it("put sends a JSON body and reports a 204 with no content as ok", async () => {
    // Jira's edit-issue endpoint is PUT and answers 204 with an empty body.
    const cap: { url?: string; init?: RequestInit } = {};
    const noContent = (async (url: string, init?: RequestInit) => {
      cap.url = url; cap.init = init;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const c = bearerRestClient("tok", noContent);
    const res = await c.put("https://api.example.com/x", { fields: { summary: "s" } });
    expect(cap.init!.method).toBe("PUT");
    expect(cap.init!.body).toBe(JSON.stringify({ fields: { summary: "s" } }));
    expect((cap.init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(res).toEqual({ status: 204, ok: true, body: null });
  });
});
