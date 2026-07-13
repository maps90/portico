import type { Express, Request, Response } from "express";
import type { Settings } from "../../config.js";
import type { UserStore } from "../../ports/identity.js";
import type { SessionCodec } from "../../adapters/session/cookie.js";
import {
  LinkingService,
  UpstreamNotConfiguredError,
  InvalidOAuthStateError,
} from "../../application/linking-service.js";
import { ConnectionNotFoundError } from "../../domain/errors.js";
import { currentUser } from "./session.js";

export interface ConnectRouteDeps {
  linking: LinkingService;
  sessions: SessionCodec;
  users: UserStore;
  settings: Settings;
}

/**
 * `/connect/:id` + `/connect/:id/callback`: session-gated upstream OAuth linking.
 *
 * Every outcome ends as a redirect back to the portal, carrying the result in the
 * query string — one click out to the vendor, one bounce back to the page you
 * started on, with the row already flipped to Connected. The portal renders the
 * banner and then strips the params from the URL.
 */
export function registerConnectRoutes(app: Express, deps: ConnectRouteDeps): void {
  const { linking, sessions, users, settings } = deps;

  /** Back to the portal with an outcome the page can render. */
  const backToPortal = (res: Response, params: Record<string, string>): void => {
    const query = new URLSearchParams(params).toString();
    res.redirect(`${settings.portalUrl}/?${query}`);
  };

  app.get("/connect/:id", async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id ?? "";
    const user = await currentUser(req, sessions, users);
    if (!user) {
      res.redirect("/login");
      return;
    }
    try {
      const { authorizeUrl } = await linking.begin(user, id);
      res.redirect(authorizeUrl);
    } catch (err) {
      if (err instanceof ConnectionNotFoundError) {
        backToPortal(res, { connect_error: "unknown_service", service: id });
      } else if (err instanceof UpstreamNotConfiguredError) {
        backToPortal(res, { connect_error: "not_configured", service: id });
      } else {
        console.error("connect begin error", err);
        backToPortal(res, { connect_error: "begin_failed", service: id });
      }
    }
  });

  app.get("/connect/:id/callback", async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id ?? "";

    // A user who declines consent comes back as ?error=access_denied.
    if (typeof req.query.error === "string") {
      backToPortal(res, { connect_error: "declined", service: id });
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (!code || !state) {
      backToPortal(res, { connect_error: "invalid_callback", service: id });
      return;
    }
    // Bind the callback to the browser session and require it to match the user who
    // began the flow (OAuth account-linking CSRF defense).
    const user = await currentUser(req, sessions, users);
    if (!user) {
      res.redirect("/login");
      return;
    }
    try {
      const { upstreamId } = await linking.complete(state, code, user.id);
      backToPortal(res, { connected: upstreamId });
    } catch (err) {
      if (err instanceof InvalidOAuthStateError) {
        backToPortal(res, { connect_error: "expired_link", service: id });
      } else {
        console.error("connect callback error", err);
        backToPortal(res, { connect_error: "exchange_failed", service: id });
      }
    }
  });
}
