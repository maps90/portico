import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import type { Pool } from "pg";
import type { Settings } from "../../config.js";
import type { OidcVerifier } from "../../ports/identity.js";
import type { UpstreamOAuthClient } from "../../ports/oauth.js";
import type { UpstreamGateway } from "../../ports/upstream.js";
import { GoogleOidcVerifier } from "../../adapters/oidc/google.js";
import { buildStores, type Stores } from "../../adapters/stores.js";
import { buildRegistry } from "../../adapters/registry/default-registry.js";
import { SessionCodec } from "../../adapters/session/cookie.js";
import { FetchUpstreamOAuthClient } from "../../adapters/upstream/oauth-client.js";
import { McpUpstreamGateway } from "../../adapters/upstream/mcp-gateway.js";
import { IdentityService } from "../../application/identity-service.js";
import { ConnectionsService } from "../../application/connections-service.js";
import { LinkingService } from "../../application/linking-service.js";
import { AccessTokenProvider } from "../../application/access.js";
import { ProxyService } from "../../application/proxy-service.js";
import { ArtifactsService } from "../../application/artifacts-service.js";
import { registerHealth } from "./health.js";
import { registerIdentityRoutes } from "./identity-routes.js";
import { registerConnectRoutes } from "./connect-routes.js";
import { registerArtifactRoutes } from "./artifact-routes.js";
import { registerApiRoutes } from "./api-routes.js";
import { registerMcpRoute } from "./mcp-routes.js";
import { page } from "./html.js";

export interface Dependencies {
  settings: Settings;
  /** Null selects in-memory stores (single-process dev / tests). */
  pool: Pool | null;
  /** Adapter overrides for tests (e.g. a fake upstream OAuth client / OIDC). */
  overrides?: {
    oauthClient?: UpstreamOAuthClient;
    oidc?: OidcVerifier;
    gateway?: UpstreamGateway;
  };
}

/** The fully wired application, exposed so integration tests can reuse it. */
export interface BuiltApp {
  app: Express;
  stores: Stores;
  identity: IdentityService;
  connections: ConnectionsService;
  linking: LinkingService;
  proxy: ProxyService;
  artifacts: ArtifactsService;
  sessions: SessionCodec;
}

/** Built portal assets (`web/dist`), reached the same way from `src/` and `dist/`. */
const WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/dist");

/** Vendored browser libs for published visuals. Resolved the same way from `src/` and `dist/`. */
const VENDOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../vendor");

/**
 * Composition root. Builds concrete adapters, injects them into application
 * services, and mounts the interface layer: health, identity (`/login`,
 * `/auth/google/callback`), upstream linking (`/connect/*`), artifacts (`/a/:id`),
 * the portal's `/api/*` surface, the portal itself, and the `/mcp` Streamable
 * HTTP endpoint.
 */
export function buildApp(deps: Dependencies): BuiltApp {
  const { settings, pool } = deps;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));

  // --- adapters ---
  const oidc =
    deps.overrides?.oidc ??
    new GoogleOidcVerifier({
      clientId: settings.google.clientId,
      clientSecret: settings.google.clientSecret,
      allowedDomains: settings.allowedDomains,
    });
  const oauthClient = deps.overrides?.oauthClient ?? new FetchUpstreamOAuthClient();
  const gateway = deps.overrides?.gateway ?? new McpUpstreamGateway();
  const stores = buildStores(pool, {
    encryptionKey: settings.encryptionKey,
    artifact: settings.artifact,
  });
  const sessions = new SessionCodec(settings.sessionSecret);
  const registry = buildRegistry(process.env);

  // --- application services ---
  const identity = new IdentityService({
    oidc,
    users: stores.users,
    tokens: stores.tokens,
    allowedDomains: settings.allowedDomains,
  });
  const connections = new ConnectionsService({
    registry,
    vault: stores.vault,
    baseUrl: settings.baseUrl,
  });
  const linking = new LinkingService({
    registry,
    vault: stores.vault,
    oauthState: stores.oauthState,
    oauthClient,
    baseUrl: settings.baseUrl,
  });
  const access = new AccessTokenProvider({ vault: stores.vault, oauthClient, registry });
  const proxy = new ProxyService({
    registry,
    vault: stores.vault,
    access,
    gateway,
    baseUrl: settings.baseUrl,
  });
  const artifacts = new ArtifactsService({
    store: stores.artifactStore,
    meta: stores.artifactMeta,
    baseUrl: settings.baseUrl,
  });

  // --- interface ---
  registerHealth(app, pool);
  registerIdentityRoutes(app, { identity, sessions, settings });
  registerConnectRoutes(app, { linking, sessions, users: stores.users, settings });
  registerArtifactRoutes(app, {
    artifacts,
    sessions,
    users: stores.users,
    baseUrl: settings.baseUrl,
  });
  registerApiRoutes(app, {
    identity,
    connections,
    sessions,
    users: stores.users,
    tokens: stores.tokens,
    settings,
  });
  registerMcpRoute(app, {
    tokens: stores.tokens,
    connections,
    proxy,
    artifacts,
    baseUrl: settings.baseUrl,
  });
  // Vendored chart libraries for published visuals. Public on purpose: these are
  // open-source bundles holding nothing secret, and gating them would couple asset
  // loading to a session cookie reaching an opaque-origin iframe. Served from their own
  // directory rather than `web/dist` so `make dev` — which never builds the portal —
  // can still render a chart.
  app.use(
    "/vendor",
    express.static(VENDOR_DIR, {
      immutable: true,
      maxAge: "1y",
      index: false,
      fallthrough: false,
    }),
  );
  registerPortal(app);

  return { app, stores, identity, connections, linking, proxy, artifacts, sessions };
}

/**
 * Serves the built portal at `/`. It is a single page with no client-side router,
 * so `/` returns index.html and the rest of `web/dist` is served as static assets.
 * Under `make dev` the Vite server hosts the portal and proxies the API back here,
 * so an unbuilt `web/dist` only affects `make run` — and then it says so instead of
 * 404ing.
 */
function registerPortal(app: Express): void {
  const built = existsSync(resolve(WEB_DIST, "index.html"));
  if (built) app.use(express.static(WEB_DIST, { index: false }));

  app.get("/", (_req: Request, res: Response) => {
    if (!built) {
      res
        .status(503)
        .send(
          page(
            "Portal not built",
            "<h1>Portal not built</h1><p>Run <code>make build</code>, or <code>make dev</code> for hot reload.</p>",
          ),
        );
      return;
    }
    // Sent relative to a root, not as an absolute path: `send` refuses any path with
    // a dot-segment in it, so an absolute send breaks whenever the app is deployed
    // under a directory like `.claude/` or `/home/user/.local/…`. Only "index.html"
    // is checked against that rule this way.
    res.sendFile("index.html", { root: WEB_DIST });
  });
}

/** Convenience for the process entry point, which only needs the Express app. */
export function createApp(deps: Dependencies): Express {
  return buildApp(deps).app;
}
