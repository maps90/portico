import { describe, it, expect, beforeEach } from "vitest";
import { IdentityService } from "./identity-service.js";
import { InMemoryUserStore } from "../adapters/memory/user-store.js";
import { InMemoryTokenStore } from "../adapters/memory/token-store.js";
import { TenantForbiddenError } from "../domain/errors.js";
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
  issuer: "https://login.microsoftonline.com/okadoc/v2.0",
  subject: "sub-1",
  email: "user@okadoc.com",
  tenantId: "okadoc",
};

const build = (claims: OidcClaims) => {
  const users = new InMemoryUserStore();
  const tokens = new InMemoryTokenStore(users);
  const service = new IdentityService({
    oidc: new FakeOidc(claims),
    users,
    tokens,
    allowedTenantId: "okadoc",
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

  it("rejects an identity outside the Okadoc tenant", async () => {
    const other = build({ ...okClaims, tenantId: "evilcorp" });
    await expect(other.service.completeLogin("code", "https://portico/cb")).rejects.toBeInstanceOf(
      TenantForbiddenError,
    );
  });
});
