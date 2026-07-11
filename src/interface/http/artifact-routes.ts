import type { Express, Request, Response } from "express";
import type { UserStore } from "../../ports/identity.js";
import type { SessionCodec } from "../../adapters/session/cookie.js";
import type { ArtifactsService } from "../../application/artifacts-service.js";
import { ArtifactForbiddenError, ArtifactNotFoundError } from "../../domain/errors.js";
import { currentUser } from "./session.js";
import { page } from "./html.js";

/**
 * Strict CSP for served artifacts: no scripts, no external requests of any kind.
 * Inline styles and data-URI images/fonts are allowed so reports render, but a
 * stored document cannot exfiltrate, phone home, or be turned into a phishing page.
 */
const ARTIFACT_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface ArtifactRouteDeps {
  artifacts: ArtifactsService;
  sessions: SessionCodec;
  users: UserStore;
}

/** `GET /a/:id` — OIDC-session-gated artifact viewer streaming bytes from blob. */
export function registerArtifactRoutes(app: Express, deps: ArtifactRouteDeps): void {
  const { artifacts, sessions, users } = deps;

  app.get("/a/:id", async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id ?? "";
    const user = await currentUser(req, sessions, users);
    if (!user) {
      res.redirect(`/login?next=${encodeURIComponent(`/a/${id}`)}`);
      return;
    }
    try {
      const { html } = await artifacts.view(user.id, id);
      res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("Content-Security-Policy", ARTIFACT_CSP)
        .set("X-Content-Type-Options", "nosniff")
        .set("Referrer-Policy", "no-referrer")
        .set("Cache-Control", "private, no-store")
        .send(html);
    } catch (err) {
      if (err instanceof ArtifactForbiddenError) {
        res.status(403).send(page("Not permitted", "<h1>Not permitted</h1><p>You don't have access to this artifact.</p>"));
      } else if (err instanceof ArtifactNotFoundError) {
        res.status(404).send(page("Not found", "<h1>Not found</h1><p>This artifact does not exist, was revoked, or has expired.</p>"));
      } else {
        console.error("artifact view error", err);
        res.status(500).send(page("Error", "<h1>Error</h1><p>Could not load this artifact.</p>"));
      }
    }
  });
}
