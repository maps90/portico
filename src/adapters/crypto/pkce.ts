import { randomBytes, createHash } from "node:crypto";

/** PKCE (RFC 7636) S256 verifier/challenge, plus a random OAuth `state`. */

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(24).toString("base64url");
}
