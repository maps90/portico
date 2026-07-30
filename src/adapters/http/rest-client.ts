import type { RestClient, RestInit, RestResponse } from "../../ports/builtin.js";

function withQuery(url: string, query?: RestInit["query"]): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

async function parseBody(res: Response): Promise<unknown> {
  const raw = await res.text();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

/** A RestClient bound to one bearer token; parses JSON and never throws on non-2xx. */
export function bearerRestClient(token: string, fetchImpl: typeof fetch = fetch): RestClient {
  const call = async (
    method: "GET" | "POST" | "PUT", url: string, body?: unknown, init?: RestInit,
  ): Promise<RestResponse> => {
    const res = await fetchImpl(withQuery(url, init?.query), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, ok: res.ok, body: await parseBody(res) };
  };
  return {
    get: (url, init) => call("GET", url, undefined, init),
    post: (url, body, init) => call("POST", url, body, init),
    put: (url, body, init) => call("PUT", url, body, init),
  };
}
