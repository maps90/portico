import { SignJWT, jwtVerify } from "jose";

/**
 * Signed browser session cookie for artifact viewing. A short-lived HS256 JWT
 * carrying the omni user id, signed with `OMNI_SESSION_SECRET`. Used only for
 * the `/a/:id` viewer and the `/connect/*` flow — the `/mcp` endpoint uses
 * opaque bearer tokens instead.
 */
export class SessionCodec {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds = 12 * 60 * 60,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(userId: string): Promise<string> {
    return new SignJWT({ sub: userId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  /** Returns the user id, or null if the cookie is missing/expired/tampered. */
  async verify(cookie: string | undefined): Promise<string | null> {
    if (!cookie) return null;
    try {
      const { payload } = await jwtVerify(cookie, this.key);
      return typeof payload.sub === "string" ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
