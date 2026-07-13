import { describe, it, expect } from "vitest";
import { isIdentityAllowed, assertIdentityAllowed } from "./identity.js";
import { DomainForbiddenError } from "./errors.js";
import type { OidcClaims } from "../ports/identity.js";

const claims = (over: Partial<OidcClaims> = {}): OidcClaims => ({
  issuer: "https://accounts.google.com",
  subject: "user-1",
  email: "a@okadoc.com",
  emailVerified: true,
  workspace: "okadoc.com",
  ...over,
});

describe("domain policy", () => {
  it("allows a configured domain", () => {
    expect(isIdentityAllowed(claims(), ["okadoc.com"])).toBe(true);
  });

  it("matches domains case-insensitively", () => {
    expect(isIdentityAllowed(claims({ workspace: "Okadoc.COM" }), ["okadoc.com"])).toBe(true);
  });

  it("DENIES everyone when the allowlist is empty — empty is not 'allow all'", () => {
    // The fail-open version of this rule would hand a bearer token to any Google
    // account the moment someone deleted a line of config.
    expect(isIdentityAllowed(claims({ workspace: "gmail.com" }), [])).toBe(false);
    expect(isIdentityAllowed(claims(), [])).toBe(false);
    expect(() => assertIdentityAllowed(claims(), [])).toThrow(DomainForbiddenError);
  });

  it("allows any verified account only when opened explicitly with '*'", () => {
    expect(isIdentityAllowed(claims({ workspace: "gmail.com" }), ["*"])).toBe(true);
    // Still requires a verified email, even wide open.
    expect(isIdentityAllowed(claims({ emailVerified: false }), ["*"])).toBe(false);
  });

  it("rejects a domain outside the allowlist", () => {
    const c = claims({ workspace: "evilcorp.com", email: "a@evilcorp.com" });
    expect(isIdentityAllowed(c, ["okadoc.com"])).toBe(false);
    expect(() => assertIdentityAllowed(c, ["okadoc.com"])).toThrow(DomainForbiddenError);
  });

  it("rejects an unverified email even when the domain matches", () => {
    const c = claims({ emailVerified: false });
    expect(isIdentityAllowed(c, ["okadoc.com"])).toBe(false);
    expect(() => assertIdentityAllowed(c, ["okadoc.com"])).toThrow(/verified email/);
  });

  it("rejects an unknown workspace when an allowlist is configured", () => {
    const c = claims({ workspace: null });
    expect(isIdentityAllowed(c, ["okadoc.com"])).toBe(false);
    expect(() => assertIdentityAllowed(c, ["okadoc.com"])).toThrow(DomainForbiddenError);
  });
});
