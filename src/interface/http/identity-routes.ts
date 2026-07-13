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

export interface IdentityRouteDeps {
  identity: IdentityService;
  sessions: SessionCodec;
  settings: Settings;
}

/**
 * `/login`, `/auth/google/callback`, `/logout`: Google sign-in → session cookie
 * (for the portal and the artifact viewer) + a bearer token (for Jean).
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
        serializeCookie(STATE_COOKIE, "", { maxAgeSeconds: 0 }),
      ]);
      res.status(200).send(
        page(
          "Signed in to Portico",
          `<h1>You're signed in${user.email ? `, ${escapeHtml(user.email)}` : ""}</h1>
           <p>This is your portico bearer token — the one token that reaches every
           service you link. Copy it into Jean's configuration now:
           <strong>it is shown only once.</strong></p>
           <pre>${escapeHtml(token)}</pre>
           <p class="muted">Lost it? Generate a new one from the portal — that
           invalidates this one.</p>
           <p><a class="btn" href="${escapeHtml(settings.portalUrl)}">Continue to the portal →</a></p>`,
        ),
      );
    } catch (err) {
      if (err instanceof DomainForbiddenError) {
        res
          .status(403)
          .send(
            page(
              "Access denied",
              `<h1>Access denied</h1><p>${escapeHtml(err.message)}</p>`,
            ),
          );
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
    res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, "", { secure, maxAgeSeconds: 0 }));
    res.redirect("/");
  });
}
