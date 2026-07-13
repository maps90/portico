import type { OidcClaims } from "../ports/identity.js";
import { DomainForbiddenError } from "./errors.js";

/**
 * Identity policy — pure rules over verified OIDC claims. No I/O.
 *
 * A portico instance may restrict sign-in to one or more Google Workspace domains
 * (`PORTICO_ALLOWED_DOMAINS`). An empty allowlist means "any verified Google
 * account", which is the sane default for local/solo use; a deployment on a public
 * URL is expected to set one.
 *
 * The email must be verified either way — an unverified address would let anyone
 * claim membership of an allowed domain.
 */
export function isIdentityAllowed(claims: OidcClaims, allowedDomains: readonly string[]): boolean {
  if (!claims.emailVerified) return false;
  if (allowedDomains.length === 0) return true;
  if (claims.workspace === null) return false;
  const workspace = claims.workspace.toLowerCase();
  return allowedDomains.some((d) => d.toLowerCase() === workspace);
}

/** Throws {@link DomainForbiddenError} unless the claims pass {@link isIdentityAllowed}. */
export function assertIdentityAllowed(claims: OidcClaims, allowedDomains: readonly string[]): void {
  if (isIdentityAllowed(claims, allowedDomains)) return;
  if (!claims.emailVerified) {
    throw new DomainForbiddenError("identity has no verified email address");
  }
  throw new DomainForbiddenError(
    `domain '${claims.workspace ?? "unknown"}' is not allowed on this portico instance`,
  );
}
