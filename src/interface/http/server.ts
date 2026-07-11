import express, { type Express } from "express";
import type { Pool } from "pg";
import type { Settings } from "../../config.js";
import type { OidcVerifier } from "../../ports/identity.js";
import type { UpstreamOAuthClient } from "../../ports/oauth.js";
import { EntraOidcVerifier } from "../../adapters/oidc/entra.js";
import { buildStores, type Stores } from "../../adapters/stores.js";
import { buildRegistry } from "../../adapters/registry/default-registry.js";
import { SessionCodec } from "../../adapters/session/cookie.js";
import { FetchUpstreamOAuthClient } from "../../adapters/upstream/oauth-client.js";
import { IdentityService } from "../../application/identity-service.js";
import { ConnectionsService } from "../../application/connections-service.js";
import { LinkingService } from "../../application/linking-service.js";
import { registerHealth } from "./health.js";
import { registerIdentityRoutes } from "./identity-routes.js";
import { registerConnectRoutes } from "./connect-routes.js";
import { registerMcpRoute } from "./mcp-routes.js";

export interface Dependencies {
  settings: Settings;
  /** Null selects in-memory stores (single-process dev / tests). */
  pool: Pool | null;
  /** Adapter overrides for tests (e.g. a fake upstream OAuth client / OIDC). */
  overrides?: {
    oauthClient?: UpstreamOAuthClient;
    oidc?: OidcVerifier;
  };
}

/** The fully wired application, exposed so integration tests can reuse it. */
export interface BuiltApp {
  app: Express;
  stores: Stores;
  identity: IdentityService;
  connections: ConnectionsService;
  linking: LinkingService;
  sessions: SessionCodec;
}

/**
 * Composition root. Builds concrete adapters, injects them into application
 * services, and mounts the interface layer: health, identity (`/login`,
 * `/auth/entra/callback`), and the `/mcp` Streamable HTTP endpoint. Later
 * milestones add `/connect/*` and `/a/:id` here.
 */
export function buildApp(deps: Dependencies): BuiltApp {
  const { settings, pool } = deps;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));

  // --- adapters ---
  const oidc =
    deps.overrides?.oidc ??
    new EntraOidcVerifier({
      tenantId: settings.entra.tenantId,
      clientId: settings.entra.clientId,
      clientSecret: settings.entra.clientSecret,
    });
  const oauthClient = deps.overrides?.oauthClient ?? new FetchUpstreamOAuthClient();
  const stores = buildStores(pool, { encryptionKey: settings.encryptionKey });
  const sessions = new SessionCodec(settings.sessionSecret);
  const registry = buildRegistry(process.env);

  // --- application services ---
  const identity = new IdentityService({
    oidc,
    users: stores.users,
    tokens: stores.tokens,
    allowedTenantId: settings.entra.tenantId,
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

  // --- interface ---
  registerHealth(app, pool);
  registerIdentityRoutes(app, { identity, sessions, settings });
  registerConnectRoutes(app, { linking, sessions, users: stores.users, settings });
  registerMcpRoute(app, { tokens: stores.tokens, connections, baseUrl: settings.baseUrl });

  return { app, stores, identity, connections, linking, sessions };
}

/** Convenience for the process entry point, which only needs the Express app. */
export function createApp(deps: Dependencies): Express {
  return buildApp(deps).app;
}
