import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadConfig } from "../../config.js";
import { buildApp, type BuiltApp } from "./server.js";
import type { OidcClaims, OidcVerifier } from "../../ports/identity.js";

const env: Record<string, string> = {
  PORTICO_BASE_URL: "http://localhost",
  PORTICO_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  PORTICO_SESSION_SECRET: "test-session-secret-value",
  PORTICO_GOOGLE_CLIENT_ID: "cid",
  PORTICO_GOOGLE_CLIENT_SECRET: "sec",
  PORTICO_ALLOWED_DOMAINS: "okadoc.com",
  PORTICO_ARTIFACT_BLOB_ACCOUNT: "acct",
};

class FakeOidc implements OidcVerifier {
  buildAuthorizationUrl(state: string, redirectUri: string): string {
    return `https://fake-idp.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  async exchangeCode(): Promise<OidcClaims> {
    return {
      issuer: "https://accounts.google.example",
      subject: "sub-1",
      email: "u@okadoc.com",
      emailVerified: true,
      workspace: "okadoc.com",
    };
  }
}

describe("login round trip (integration, in-memory)", () => {
  let built: BuiltApp;
  let server: Server;
  let origin: string;
  let portalUrl: string;

  beforeAll(async () => {
    const settings = loadConfig(env);
    portalUrl = settings.portalUrl;
    built = buildApp({ settings, pool: null, overrides: { oidc: new FakeOidc() } });
    server = await new Promise<Server>((resolve) => {
      const s = built.app.listen(0, () => resolve(s));
    });
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * A cookie jar, because the point of several of these tests is what the *browser*
   * ends up holding: a later `Set-Cookie` replaces an earlier one of the same name,
   * and `Max-Age=0` deletes it rather than sitting beside it.
   */
  class Jar {
    private readonly byName = new Map<string, string>();

    absorb(res: Response): this {
      for (const raw of res.headers.getSetCookie()) {
        const [pair, ...attrs] = raw.split(";");
        const idx = pair!.indexOf("=");
        const name = pair!.slice(0, idx).trim();
        const value = pair!.slice(idx + 1).trim();
        const expired = attrs.some((a) => a.trim().toLowerCase() === "max-age=0");
        if (!value || expired) this.byName.delete(name);
        else this.byName.set(name, value);
      }
      return this;
    }

    header(): string {
      return [...this.byName].map(([n, v]) => `${n}=${v}`).join("; ");
    }
  }

  /** Runs a whole sign-in and returns where the callback finally sends the browser. */
  const signIn = async (loginPath: string, jar = new Jar()): Promise<string> => {
    const begin = await fetch(`${origin}${loginPath}`, {
      headers: { cookie: jar.header() },
      redirect: "manual",
    });
    expect(begin.status).toBe(302);
    jar.absorb(begin);
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;

    const cb = await fetch(`${origin}/auth/google/callback?state=${state}&code=the-code`, {
      headers: { cookie: jar.header() },
      redirect: "manual",
    });
    expect(cb.status).toBe(302);
    return cb.headers.get("location")!;
  };

  it("lands the visitor on ?next= after sign-in, not on the portal", async () => {
    expect(await signIn("/login?next=%2Fvisual%2Fabc-123")).toBe("/visual/abc-123");
  });

  it("keeps the query string of the requested destination", async () => {
    const next = encodeURIComponent("/visual/abc-123?embed=1");
    expect(await signIn(`/login?next=${next}`)).toBe("/visual/abc-123?embed=1");
  });

  it("falls back to the portal when no destination was requested", async () => {
    expect(await signIn("/login")).toBe(portalUrl);
  });

  it("does not inherit the destination of an abandoned earlier login", async () => {
    // The visitor asks for a visual, never finishes that sign-in, and later starts
    // again from the front door — in the same browser, carrying the same jar.
    const jar = new Jar();
    jar.absorb(await fetch(`${origin}/login?next=%2Fvisual%2Fstale`, { redirect: "manual" }));

    expect(await signIn("/login", jar)).toBe(portalUrl);
  });

  it.each([
    ["an absolute URL", "https://evil.example/phish"],
    ["a protocol-relative URL", "//evil.example/phish"],
    ["a backslash-led URL some browsers normalize to //", "/\\evil.example/phish"],
    ["a scheme with no host", "javascript:alert(1)"],
    ["a header-splitting attempt", "/visual/a\r\nLocation: https://evil.example"],
  ])("refuses %s as a destination and uses the portal instead", async (_label, next) => {
    expect(await signIn(`/login?next=${encodeURIComponent(next)}`)).toBe(portalUrl);
  });

  it("sends an anonymous visual visitor through /login carrying that visual as ?next=", async () => {
    const user = await built.stores.users.upsertByIdentity({
      issuer: "iss",
      subject: "sub-visual",
      email: "owner@okadoc.com",
    });
    const { id } = await built.artifacts.publish(user, { html: "<p>hi</p>" });

    const gated = await fetch(`${origin}/visual/${id}`, { redirect: "manual" });
    expect(gated.status).toBe(302);
    expect(gated.headers.get("location")).toBe(`/login?next=${encodeURIComponent(`/visual/${id}`)}`);

    // …and following that hand-off really does end on the visual.
    expect(await signIn(gated.headers.get("location")!)).toBe(`/visual/${id}`);
  });
});
