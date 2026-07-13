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

  it("allows any verified account when the allowlist is empty", () => {
    expect(isIdentityAllowed(claims({ workspace: "gmail.com" }), [])).toBe(true);
  });

  it("rejects a domain outside the allowlist", () => {
    const c = claims({ workspace: "evilcorp.com", email: "a@evilcorp.com" });
    expect(isIdentityAllowed(c, ["okadoc.com"])).toBe(false);
    expect(() => assertIdentityAllowed(c, ["okadoc.com"])).toThrow(DomainForbiddenError);
  });

  it("rejects an unverified email even when the domain matches", () => {
    const c = claims({ emailVerified: false });
    expect(isIdentityAllowed(c, ["okadoc.com"])).toBe(false);
    expect(isIdentityAllowed(c, [])).toBe(false);
    expect(() => assertIdentityAllowed(c, [])).toThrow(/verified email/);
  });

  it("rejects an unknown workspace when an allowlist is configured", () => {
    const c = claims({ workspace: null });
    expect(isIdentityAllowed(c, ["okadoc.com"])).toBe(false);
    expect(() => assertIdentityAllowed(c, ["okadoc.com"])).toThrow(DomainForbiddenError);
  });
});
