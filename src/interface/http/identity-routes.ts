import { randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { Settings } from "../../config.js";
import type { IdentityService } from "../../application/identity-service.js";
import type { SessionCodec } from "../../adapters/session/cookie.js";
import { DomainForbiddenError } from "../../domain/errors.js";
import { parseCookies, serializeCookie } from "./cookies.js";
import { escapeHtml, page } from "./html.js";

export const SESSION_COOKIE = "portico_session";
const STATE_COOKIE = "portico_login_state";

/**
 * Carries the freshly minted bearer token from the login callback to the portal,
 * which is a separate page load. HttpOnly, so the token is never readable by
 * script — the portal gets it from `GET /api/token/pending`, which returns it once
 * and clears this cookie. Short-lived: it exists only for that hand-off.
 */
export const NEW_TOKEN_COOKIE = "portico_new_token";
export const NEW_TOKEN_TTL_SECONDS = 300;

export interface IdentityRouteDeps {
  identity: IdentityService;
  sessions: SessionCodec;
  settings: Settings;
}

/**
 * `/login`, `/auth/google/callback`, `/logout`.
 *
 * A successful sign-in mints the bearer token and drops the browser straight onto
 * the portal — the token is revealed there, in the token card, rather than on an
 * interstitial page. One page after login, which is the whole point of the portal.
 */
export function registerIdentityRoutes(app: Express, deps: IdentityRouteDeps): void {
  const { identity, sessions, settings } = deps;
  const secure = settings.baseUrl.startsWith("https");
  const redirectUri = `${settings.baseUrl}/auth/google/callback`;

  app.get("/login", (_req: Request, res: Response) => {
    const state = randomBytes(16).toString("base64url");
    res.setHeader(
      "Set-Cookie",
      serializeCookie(STATE_COOKIE, state, { httpOnly: true, secure, maxAgeSeconds: 600 }),
    );
    res.redirect(identity.beginLogin(state, redirectUri));
  });

  app.get("/auth/google/callback", async (req: Request, res: Response) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const cookieState = parseCookies(req.headers.cookie)[STATE_COOKIE];

    if (!code || !state || !cookieState || state !== cookieState) {
      res
        .status(400)
        .send(
          page(
            "Login failed",
            '<h1>Login failed</h1><p>Invalid or expired login request. <a href="/login">Try again</a>.</p>',
          ),
        );
      return;
    }

    try {
      const { user, token } = await identity.completeLogin(code, redirectUri);
      const session = await sessions.sign(user.id);
      res.setHeader("Set-Cookie", [
        serializeCookie(SESSION_COOKIE, session, {
          httpOnly: true,
          secure,
          sameSite: "Lax",
          maxAgeSeconds: 12 * 60 * 60,
        }),
        serializeCookie(NEW_TOKEN_COOKIE, token, {
          httpOnly: true,
          secure,
          sameSite: "Lax",
          maxAgeSeconds: NEW_TOKEN_TTL_SECONDS,
        }),
        serializeCookie(STATE_COOKIE, "", { maxAgeSeconds: 0 }),
      ]);
      res.redirect(settings.portalUrl);
    } catch (err) {
      if (err instanceof DomainForbiddenError) {
        res
          .status(403)
          .send(page("Access denied", `<h1>Access denied</h1><p>${escapeHtml(err.message)}</p>`));
        return;
      }
      console.error("login callback error", err);
      res
        .status(502)
        .send(
          page(
            "Login error",
            "<h1>Login error</h1><p>Could not complete sign-in. Please try again.</p>",
          ),
        );
    }
  });

  app.get("/logout", (_req: Request, res: Response) => {
    res.setHeader("Set-Cookie", [
      serializeCookie(SESSION_COOKIE, "", { secure, maxAgeSeconds: 0 }),
      // Never leave an unclaimed token behind for the next person on this browser.
      serializeCookie(NEW_TOKEN_COOKIE, "", { secure, maxAgeSeconds: 0 }),
    ]);
    res.redirect("/");
  });
}
