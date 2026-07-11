import type { Request } from "express";
import type { UserStore, User } from "../../ports/identity.js";
import type { SessionCodec } from "../../adapters/session/cookie.js";
import { parseCookies } from "./cookies.js";
import { SESSION_COOKIE } from "./identity-routes.js";

/** Resolves the browser session cookie to a user, or null if not signed in. */
export async function currentUser(
  req: Request,
  sessions: SessionCodec,
  users: UserStore,
): Promise<User | null> {
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const userId = await sessions.verify(cookie);
  return userId ? users.getById(userId) : null;
}
