import { describe, it, expect, beforeEach } from "vitest";
import { IdentityService } from "./identity-service.js";
import { InMemoryUserStore } from "../adapters/memory/user-store.js";
import { InMemoryTokenStore } from "../adapters/memory/token-store.js";
import { DomainForbiddenError } from "../domain/errors.js";
import type { OidcClaims, OidcVerifier } from "../ports/identity.js";

class FakeOidc implements OidcVerifier {
  constructor(private claims: OidcClaims) {}
  buildAuthorizationUrl(state: string, redirectUri: string): string {
    return `https://idp.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  async exchangeCode(): Promise<OidcClaims> {
    return this.claims;
  }
}

const okClaims: OidcClaims = {
  issuer: "https://accounts.google.com",
  subject: "sub-1",
  email: "user@okadoc.com",
  emailVerified: true,
  workspace: "okadoc.com",
};

const build = (claims: OidcClaims, allowedDomains: string[] = ["okadoc.com"]) => {
  const users = new InMemoryUserStore();
  const tokens = new InMemoryTokenStore(users);
  const service = new IdentityService({
    oidc: new FakeOidc(claims),
    users,
    tokens,
    allowedDomains,
  });
  return { users, tokens, service };
};

describe("IdentityService", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build(okClaims);
  });

  it("builds an authorization URL carrying the state", () => {
    const url = ctx.service.beginLogin("xyz", "https://portico/cb");
    expect(url).toContain("state=xyz");
  });

  it("completes login: upserts the user and mints a usable token", async () => {
    const { user, token } = await ctx.service.completeLogin("code", "https://portico/cb");
    expect(user.email).toBe("user@okadoc.com");
    const resolved = await ctx.tokens.resolve(token);
    expect(resolved?.id).toBe(user.id);
  });

  it("is idempotent on identity: same (issuer, subject) → same user", async () => {
    const a = await ctx.service.completeLogin("c1", "https://portico/cb");
    const b = await ctx.service.completeLogin("c2", "https://portico/cb");
    expect(a.user.id).toBe(b.user.id);
  });

  it("rejects an identity outside the allowed domains", async () => {
    const other = build({ ...okClaims, workspace: "evilcorp.com" });
    await expect(other.service.completeLogin("code", "https://portico/cb")).rejects.toBeInstanceOf(
      DomainForbiddenError,
    );
  });

  it("accepts any verified account only when explicitly opened with '*'", async () => {
    const open = build({ ...okClaims, workspace: "gmail.com" }, ["*"]);
    const { user } = await open.service.completeLogin("code", "https://portico/cb");
    expect(user.id).toBeTruthy();
  });

  it("regenerating a token invalidates every previous one", async () => {
    const { user, token: first } = await ctx.service.completeLogin("code", "https://portico/cb");
    const { token: second } = await ctx.service.regenerateToken(user);

    expect(second).not.toBe(first);
    expect(await ctx.tokens.resolve(first)).toBeNull();
    expect((await ctx.tokens.resolve(second))?.id).toBe(user.id);
    expect(await ctx.tokens.listActive(user.id)).toHaveLength(1);
  });
});
