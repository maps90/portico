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
import { escapeHtml, page } from "./html.js";

export interface ConnectRouteDeps {
  linking: LinkingService;
  sessions: SessionCodec;
  users: UserStore;
  settings: Settings;
}

/**
 * `/connect/:id` + `/connect/:id/callback`: session-gated upstream OAuth linking.
 * The browser must carry a valid omni session cookie (from `/login`); the flow
 * redirects to the upstream's authorize URL and stores the connection on return.
 */
export function registerConnectRoutes(app: Express, deps: ConnectRouteDeps): void {
  const { linking, sessions, users } = deps;

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
        res.status(404).send(page("Unknown service", `<h1>Unknown service</h1><p>No upstream '${escapeHtml(id)}'.</p>`));
      } else if (err instanceof UpstreamNotConfiguredError) {
        res.status(503).send(page("Service unavailable", `<h1>Not available</h1><p>'${escapeHtml(id)}' is not configured on this omni instance.</p>`));
      } else {
        console.error("connect begin error", err);
        res.status(502).send(page("Connect error", "<h1>Connect error</h1><p>Could not start the connection. Please try again.</p>"));
      }
    }
  });

  app.get("/connect/:id/callback", async (req: Request, res: Response) => {
    // User-declined consent surfaces as ?error=access_denied.
    if (typeof req.query.error === "string") {
      res.status(400).send(page("Connection declined", `<h1>Connection declined</h1><p>${escapeHtml(req.query.error)}</p>`));
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (!code || !state) {
      res.status(400).send(page("Connection failed", "<h1>Connection failed</h1><p>Missing code or state.</p>"));
      return;
    }
    // Bind the callback to the browser session and require it to match the user
    // who began the flow (OAuth account-linking CSRF defense).
    const user = await currentUser(req, sessions, users);
    if (!user) {
      res.redirect("/login");
      return;
    }
    try {
      const { upstreamId } = await linking.complete(state, code, user.id);
      res.status(200).send(
        page(
          "Service connected",
          `<h1>Connected ✓</h1><p>'${escapeHtml(upstreamId)}' is now linked to your omni account.
           You can close this tab and return to Jean — its tools are available immediately.</p>`,
        ),
      );
    } catch (err) {
      if (err instanceof InvalidOAuthStateError) {
        res.status(400).send(page("Connection failed", "<h1>Connection failed</h1><p>This link has expired or was already used. Start again from Jean.</p>"));
      } else {
        console.error("connect callback error", err);
        res.status(502).send(page("Connection error", "<h1>Connection error</h1><p>Could not complete the connection. Please try again.</p>"));
      }
    }
  });
}
