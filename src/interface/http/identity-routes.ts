import { randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { Settings } from "../../config.js";
import type { IdentityService } from "../../application/identity-service.js";
import type { SessionCodec } from "../../adapters/session/cookie.js";
import { TenantForbiddenError } from "../../domain/errors.js";
import { parseCookies, serializeCookie } from "./cookies.js";
import { escapeHtml, page } from "./html.js";

export const SESSION_COOKIE = "omni_session";
const STATE_COOKIE = "omni_login_state";

export interface IdentityRouteDeps {
  identity: IdentityService;
  sessions: SessionCodec;
  settings: Settings;
}

/** `/login` + `/auth/entra/callback`: OIDC login → session cookie + bearer token. */
export function registerIdentityRoutes(app: Express, deps: IdentityRouteDeps): void {
  const { identity, sessions, settings } = deps;
  const secure = settings.baseUrl.startsWith("https");
  const redirectUri = `${settings.baseUrl}/auth/entra/callback`;

  app.get("/login", (_req: Request, res: Response) => {
    const state = randomBytes(16).toString("base64url");
    res.setHeader(
      "Set-Cookie",
      serializeCookie(STATE_COOKIE, state, { httpOnly: true, secure, maxAgeSeconds: 600 }),
    );
    res.redirect(identity.beginLogin(state, redirectUri));
  });

  app.get("/auth/entra/callback", async (req: Request, res: Response) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const cookieState = parseCookies(req.headers.cookie)[STATE_COOKIE];

    if (!code || !state || !cookieState || state !== cookieState) {
      res.status(400).send(page("Login failed", "<h1>Login failed</h1><p>Invalid or expired login request. <a href=\"/login\">Try again</a>.</p>"));
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
          "Connected to omni",
          `<h1>You're signed in${user.email ? `, ${escapeHtml(user.email)}` : ""}</h1>
           <p>Copy this token into Jean's configuration as your omni-mcp bearer token.
           <strong>It is shown only once.</strong></p>
           <pre>${escapeHtml(token)}</pre>
           <p class="muted">Then link your services (Jira, Google Drive, …) from the
           omni tools inside Jean, or by visiting the connect links they return.</p>`,
        ),
      );
    } catch (err) {
      if (err instanceof TenantForbiddenError) {
        res.status(403).send(page("Access denied", "<h1>Access denied</h1><p>This omni instance is restricted to Okadoc accounts.</p>"));
        return;
      }
      console.error("login callback error", err);
      res.status(502).send(page("Login error", "<h1>Login error</h1><p>Could not complete sign-in. Please try again.</p>"));
    }
  });
}
