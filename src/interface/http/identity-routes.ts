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
 * Where the visitor was headed before the login gate bounced them, carried across the
 * round trip to Google. A cookie rather than an OAuth `state` field: `state` is echoed
 * back by the IdP and is the CSRF token, so it stays a bare nonce we can compare.
 */
const NEXT_COOKIE = "portico_login_next";
const LOGIN_COOKIE_TTL_SECONDS = 600;

/**
 * Accepts only a same-site path to return to. Anything absolute
 * (`https://evil.example`), protocol-relative (`//evil.example`), or backslash-led
 * (`/\evil.example`, which some browsers normalize into `//`) would make `/login` an
 * open redirect — a portico URL that lands the visitor on someone else's page, right
 * after they typed their Google password. Control characters are refused too, since
 * they would let a crafted value inject a second response header.
 */
function safeNext(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}

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
 * A successful sign-in mints the bearer token and drops the browser onto the portal —
 * the token is revealed there, in the token card, rather than on an interstitial page.
 * One page after login, which is the whole point of the portal.
 *
 * Unless the visitor was already going somewhere: a gated route bounces them to
 * `/login?next=<path>`, and then that path, not the portal, is where they land. Someone
 * who clicks a shared `/visual/<id>` link and signs in expects the visual, not a
 * dashboard with no hint of what they came for.
 */
export function registerIdentityRoutes(app: Express, deps: IdentityRouteDeps): void {
  const { identity, sessions, settings } = deps;
  const secure = settings.baseUrl.startsWith("https");
  const redirectUri = `${settings.baseUrl}/auth/google/callback`;

  app.get("/login", (req: Request, res: Response) => {
    const state = randomBytes(16).toString("base64url");
    const next = safeNext(req.query.next);
    res.setHeader("Set-Cookie", [
      serializeCookie(STATE_COOKIE, state, {
        httpOnly: true,
        secure,
        maxAgeSeconds: LOGIN_COOKIE_TTL_SECONDS,
      }),
      // Always written, even with no `next`: a bare /login must clear the destination
      // left behind by an earlier attempt the visitor abandoned, not inherit it.
      serializeCookie(NEXT_COOKIE, next ?? "", {
        httpOnly: true,
        secure,
        maxAgeSeconds: next ? LOGIN_COOKIE_TTL_SECONDS : 0,
      }),
    ]);
    res.redirect(identity.beginLogin(state, redirectUri));
  });

  app.get("/auth/google/callback", async (req: Request, res: Response) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const cookies = parseCookies(req.headers.cookie);
    const cookieState = cookies[STATE_COOKIE];
    // Re-validated on the way out, not just on the way in: the cookie is unsigned, so
    // anything that could write it (a sibling subdomain) must still not choose an
    // off-site landing page.
    const next = safeNext(cookies[NEXT_COOKIE]);

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
        serializeCookie(NEXT_COOKIE, "", { maxAgeSeconds: 0 }),
      ]);
      res.redirect(next ?? settings.portalUrl);
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
