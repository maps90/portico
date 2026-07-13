import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from "jose";
import { GoogleOidcVerifier, type GoogleEndpoints } from "./google.js";

const CLIENT_ID = "portico-test.apps.googleusercontent.com";
const ISSUER = "https://accounts.google.com";

/**
 * A stand-in for Google: serves a JWKS and a token endpoint that returns an
 * id_token signed with the matching key. Lets the adapter's real verification
 * path (signature, audience, issuer) run against controllable claims.
 */
class FakeGoogle {
  private server!: Server;
  private privateKey!: KeyLike;
  claims: Record<string, unknown> = {};
  endpoints!: GoogleEndpoints;

  async start(): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    this.privateKey = privateKey;
    const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

    this.server = createServer((req, res) => {
      if (req.url?.startsWith("/certs")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (req.url?.startsWith("/token")) {
        void this.signIdToken().then((idToken) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ id_token: idToken, access_token: "ignored" }));
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => this.server.listen(0, resolve));
    const base = `http://localhost:${(this.server.address() as AddressInfo).port}`;
    this.endpoints = {
      authorizationUrl: `${base}/authorize`,
      tokenUrl: `${base}/token`,
      jwksUrl: `${base}/certs`,
      issuers: [ISSUER],
    };
  }

  private signIdToken(): Promise<string> {
    return new SignJWT(this.claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(this.privateKey);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe("GoogleOidcVerifier", () => {
  const google = new FakeGoogle();
  const build = (allowedDomains: string[] = []) =>
    new GoogleOidcVerifier({
      clientId: CLIENT_ID,
      clientSecret: "secret",
      allowedDomains,
      endpoints: google.endpoints,
    });

  beforeAll(() => google.start());
  afterAll(() => google.stop());

  it("builds an authorization URL with the OIDC params and no extra scopes", () => {
    const url = new URL(build().buildAuthorizationUrl("st8", "https://portico/cb"));
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("redirect_uri")).toBe("https://portico/cb");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("hd")).toBeNull();
  });

  it("hints `hd` to the account chooser when exactly one domain is allowed", () => {
    const url = new URL(build(["okadoc.com"]).buildAuthorizationUrl("s", "https://portico/cb"));
    expect(url.searchParams.get("hd")).toBe("okadoc.com");
  });

  it("omits `hd` when several domains are allowed", () => {
    const url = new URL(
      build(["okadoc.com", "example.org"]).buildAuthorizationUrl("s", "https://portico/cb"),
    );
    expect(url.searchParams.get("hd")).toBeNull();
  });

  it("verifies a Workspace id_token and reports `hd` as the workspace", async () => {
    google.claims = {
      sub: "1234",
      email: "u@okadoc.com",
      email_verified: true,
      hd: "okadoc.com",
    };
    const claims = await build().exchangeCode("code", "https://portico/cb");
    expect(claims).toEqual({
      issuer: ISSUER,
      subject: "1234",
      email: "u@okadoc.com",
      emailVerified: true,
      workspace: "okadoc.com",
    });
  });

  it("falls back to the email domain for a consumer account with no `hd`", async () => {
    google.claims = { sub: "5678", email: "someone@gmail.com", email_verified: true };
    const claims = await build().exchangeCode("code", "https://portico/cb");
    expect(claims.workspace).toBe("gmail.com");
    expect(claims.emailVerified).toBe(true);
  });

  it("carries through an unverified email so the domain policy can reject it", async () => {
    google.claims = { sub: "9", email: "u@okadoc.com", email_verified: false, hd: "okadoc.com" };
    const claims = await build().exchangeCode("code", "https://portico/cb");
    expect(claims.emailVerified).toBe(false);
  });

  it("rejects an id_token minted for a different client", async () => {
    google.claims = { sub: "1", email: "u@okadoc.com", email_verified: true };
    const wrongAudience = new GoogleOidcVerifier({
      clientId: "someone-elses-client-id",
      clientSecret: "secret",
      endpoints: google.endpoints,
    });
    await expect(wrongAudience.exchangeCode("code", "https://portico/cb")).rejects.toThrow();
  });
});
