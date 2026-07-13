import type { Express, Request, Response } from "express";
import type { Settings } from "../../config.js";
import type { TokenStore, User, UserStore } from "../../ports/identity.js";
import type { SessionCodec } from "../../adapters/session/cookie.js";
import type { ConnectionsService } from "../../application/connections-service.js";
import type { IdentityService } from "../../application/identity-service.js";
import { currentUser } from "./session.js";
import { parseCookies, serializeCookie } from "./cookies.js";
import { NEW_TOKEN_COOKIE } from "./identity-routes.js";

export interface ApiRouteDeps {
  identity: IdentityService;
  connections: ConnectionsService;
  sessions: SessionCodec;
  users: UserStore;
  tokens: TokenStore;
  settings: Settings;
}

/**
 * Header the portal must send on every state-changing request. Browsers will not
 * let a cross-site form or navigation set a custom header, so requiring it —
 * alongside the SameSite=Lax session cookie — closes the CSRF hole that
 * cookie-authenticated POSTs would otherwise open.
 */
export const PORTAL_HEADER = "x-portico-portal";

/**
 * `/api/*` — the JSON surface the React portal talks to. Authenticated by the
 * browser session cookie, never by the bearer token: the bearer token is for
 * MCP clients, and letting it drive the portal would widen its blast radius.
 */
export function registerApiRoutes(app: Express, deps: ApiRouteDeps): void {
  const { identity, connections, sessions, users, tokens, settings } = deps;
  const isSecure = settings.baseUrl.startsWith("https");

  /** Resolves the session, or writes a 401 and returns null. */
  const requireUser = async (req: Request, res: Response): Promise<User | null> => {
    const user = await currentUser(req, sessions, users);
    if (!user) {
      res.status(401).json({ error: "not_signed_in", loginUrl: "/login" });
      return null;
    }
    return user;
  };

  // In `make dev` the portal is served by Vite on its own origin and proxies here,
  // so its origin is trusted too; in production the two are the same string.
  const allowedOrigins = new Set([settings.baseUrl, settings.portalUrl]);

  /** True when the request carries the portal header and a trusted `Origin`. */
  const isPortalRequest = (req: Request): boolean => {
    if (req.get(PORTAL_HEADER) !== "1") return false;
    const origin = req.get("origin");
    return origin === undefined || allowedOrigins.has(origin);
  };

  const requirePortal = (req: Request, res: Response): boolean => {
    if (isPortalRequest(req)) return true;
    res.status(403).json({ error: "forbidden" });
    return false;
  };

  /**
   * Claims the token minted during login, exactly once. The login callback parked it
   * in an HttpOnly cookie (script can't read it) and redirected here; this hands it
   * to the portal and clears the cookie in the same response, so a reload can't
   * surface it again. Returns `null` when there's nothing pending — the normal case
   * for a returning visit.
   */
  app.get("/api/token/pending", async (req: Request, res: Response) => {
    const user = await requireUser(req, res);
    if (!user) return;

    const token = parseCookies(req.headers.cookie)[NEW_TOKEN_COOKIE] ?? null;
    if (token) {
      res.setHeader(
        "Set-Cookie",
        serializeCookie(NEW_TOKEN_COOKIE, "", { secure: isSecure, maxAgeSeconds: 0 }),
      );
    }
    res.json({ token: token || null });
  });

  app.get("/api/me", async (req: Request, res: Response) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const active = await tokens.listActive(user.id);
    res.json({
      id: user.id,
      email: user.email,
      tokenCount: active.length,
      // Only metadata: raw tokens are hashed at rest and unrecoverable.
      tokens: active.map((t) => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt.toISOString(),
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      })),
    });
  });

  app.get("/api/connections", async (req: Request, res: Response) => {
    const user = await requireUser(req, res);
    if (!user) return;
    res.json({ connections: await connections.list(user) });
  });

  app.post("/api/connections/:id/disconnect", async (req: Request, res: Response) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!requirePortal(req, res)) return;
    const id = (req.params as Record<string, string>).id ?? "";
    const ok = await connections.disconnect(user, id);
    if (!ok) {
      res.status(404).json({ error: "unknown_service", service: id });
      return;
    }
    res.json({ connections: await connections.list(user) });
  });

  /** Mints a fresh bearer token and revokes the user's previous ones. Shown once. */
  app.post("/api/token/rotate", async (req: Request, res: Response) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!requirePortal(req, res)) return;
    const { token } = await identity.regenerateToken(user);
    res.json({ token });
  });
}
