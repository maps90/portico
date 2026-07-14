import type { Express, Request, Response } from "express";
import type { UserStore } from "../../ports/identity.js";
import type { SessionCodec } from "../../adapters/session/cookie.js";
import type { ArtifactsService } from "../../application/artifacts-service.js";
import { ArtifactForbiddenError, ArtifactNotFoundError } from "../../domain/errors.js";
import { currentUser } from "./session.js";
import { page } from "./html.js";
import { shellHtml, artifactCsp, shellCsp } from "./visual-shell.js";

export interface ArtifactRouteDeps {
  artifacts: ArtifactsService;
  sessions: SessionCodec;
  users: UserStore;
  /** Origin named explicitly in both CSPs; `'self'` is unreliable in a sandboxed frame. */
  baseUrl: string;
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof ArtifactForbiddenError) {
    res
      .status(403)
      .send(page("Not permitted", "<h1>Not permitted</h1><p>You don't have access to this visual.</p>"));
  } else if (err instanceof ArtifactNotFoundError) {
    res
      .status(404)
      .send(
        page(
          "Not found",
          "<h1>Not found</h1><p>This visual does not exist, was revoked, or has expired.</p>",
        ),
      );
  } else {
    console.error("visual view error", err);
    res.status(500).send(page("Error", "<h1>Error</h1><p>Could not load this visual.</p>"));
  }
}

/**
 * The visual host.
 *
 * `/visual/:id`     — trusted, script-free shell; frames the artifact.
 * `/visual/:id/raw` — the untrusted artifact itself, opaque-origin sandboxed by the shell.
 * `/a/:id`          — legacy links, redirected.
 *
 * Both visual routes are session-gated and both run the full visibility check: `/raw` is a
 * URL a person can paste into a browser, so it defends itself rather than trusting the shell.
 */
export function registerArtifactRoutes(app: Express, deps: ArtifactRouteDeps): void {
  const { artifacts, sessions, users, baseUrl } = deps;

  // Legacy artifact links, shared before the visual host existed, keep working.
  app.get("/a/:id", (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id ?? "";
    res.redirect(301, `/visual/${encodeURIComponent(id)}`);
  });

  app.get("/visual/:id", async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id ?? "";
    const user = await currentUser(req, sessions, users);
    if (!user) {
      res.redirect(`/login?next=${encodeURIComponent(`/visual/${id}`)}`);
      return;
    }
    try {
      // viewMeta, not view: rendering chrome must not pull megabytes out of blob storage.
      const meta = await artifacts.viewMeta(user.id, id);
      res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("Content-Security-Policy", shellCsp(baseUrl))
        .set("X-Content-Type-Options", "nosniff")
        .set("Referrer-Policy", "no-referrer")
        .set("Cache-Control", "private, no-store")
        .send(shellHtml(meta.title ?? "Visual", `/visual/${encodeURIComponent(id)}/raw`));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/visual/:id/raw", async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id ?? "";
    const user = await currentUser(req, sessions, users);
    if (!user) {
      // To the shell, not back to /raw: a bare artifact document is not a destination
      // we want to land a person on.
      res.redirect(`/login?next=${encodeURIComponent(`/visual/${id}`)}`);
      return;
    }
    try {
      const { html } = await artifacts.view(user.id, id);
      res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("Content-Security-Policy", artifactCsp(baseUrl))
        .set("X-Content-Type-Options", "nosniff")
        .set("Referrer-Policy", "no-referrer")
        .set("Cache-Control", "private, no-store")
        .send(html);
    } catch (err) {
      sendError(res, err);
    }
  });
}
