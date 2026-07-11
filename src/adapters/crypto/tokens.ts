import { randomBytes, createHash } from "node:crypto";

/**
 * Opaque bearer tokens for the `/mcp` endpoint. The raw token is shown to the
 * user exactly once; only its SHA-256 hash is persisted, so a store leak does
 * not expose usable tokens. Both the in-memory and Postgres token stores use
 * these helpers so they stay equivalent.
 */

const TOKEN_PREFIX = "portico_";

export function generateBearerToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}
