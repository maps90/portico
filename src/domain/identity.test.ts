import { describe, it, expect } from "vitest";
import { isTenantAllowed, assertTenantAllowed } from "./identity.js";
import { TenantForbiddenError } from "./errors.js";
import type { OidcClaims } from "../ports/identity.js";

const claims = (tid: string | null): OidcClaims => ({
  issuer: "https://login.microsoftonline.com/okadoc/v2.0",
  subject: "user-1",
  email: "a@okadoc.com",
  tenantId: tid,
});

describe("tenant policy", () => {
  it("allows the configured Okadoc tenant", () => {
    expect(isTenantAllowed(claims("okadoc"), "okadoc")).toBe(true);
  });

  it("rejects a different tenant", () => {
    expect(isTenantAllowed(claims("other"), "okadoc")).toBe(false);
    expect(() => assertTenantAllowed(claims("other"), "okadoc")).toThrow(TenantForbiddenError);
  });

  it("rejects a missing tenant claim", () => {
    expect(isTenantAllowed(claims(null), "okadoc")).toBe(false);
    expect(() => assertTenantAllowed(claims(null), "okadoc")).toThrow(TenantForbiddenError);
  });
});
