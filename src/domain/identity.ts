import type { OidcClaims } from "../ports/identity.js";
import { TenantForbiddenError } from "./errors.js";

/**
 * Identity policy — pure rules over verified OIDC claims. No I/O.
 *
 * Okadoc runs single-tenant on Microsoft Entra: an identity is only accepted if
 * its tenant id (`tid`) matches the configured Okadoc tenant. The Entra adapter
 * already scopes JWKS/issuer per tenant, but we enforce it here too so the rule
 * is explicit, testable, and independent of the adapter.
 */
export function isTenantAllowed(claims: OidcClaims, allowedTenantId: string): boolean {
  return claims.tenantId !== null && claims.tenantId === allowedTenantId;
}

/** Throws {@link TenantForbiddenError} unless the claims belong to the allowed tenant. */
export function assertTenantAllowed(claims: OidcClaims, allowedTenantId: string): void {
  if (!isTenantAllowed(claims, allowedTenantId)) {
    throw new TenantForbiddenError(
      `identity tenant '${claims.tenantId ?? "unknown"}' is not the allowed Okadoc tenant`,
    );
  }
}
