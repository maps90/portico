import express, { type Express } from "express";
import type { Pool } from "pg";
import type { Settings } from "../../config.js";
import { EntraOidcVerifier } from "../../adapters/oidc/entra.js";
import { buildStores } from "../../adapters/stores.js";
import { SessionCodec } from "../../adapters/session/cookie.js";
import { IdentityService } from "../../application/identity-service.js";
import { registerHealth } from "./health.js";
import { registerIdentityRoutes } from "./identity-routes.js";

export interface Dependencies {
  settings: Settings;
  /** Null selects in-memory stores (single-process dev / tests). */
  pool: Pool | null;
}

/**
 * Composition root. Builds concrete adapters, injects them into application
 * services, and mounts the interface layer.
 *
 * Mounted so far: health, identity (`/login`, `/auth/entra/callback`). Later
 * milestones add the `/mcp` endpoint, `/connect/*`, and `/a/:id` here.
 */
export function createApp(deps: Dependencies): Express {
  const { settings, pool } = deps;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));

  // --- adapters ---
  const oidc = new EntraOidcVerifier({
    tenantId: settings.entra.tenantId,
    clientId: settings.entra.clientId,
    clientSecret: settings.entra.clientSecret,
  });
  const { users, tokens } = buildStores(pool);
  const sessions = new SessionCodec(settings.sessionSecret);

  // --- application services ---
  const identity = new IdentityService({
    oidc,
    users,
    tokens,
    allowedTenantId: settings.entra.tenantId,
  });

  // --- interface ---
  registerHealth(app, pool);
  registerIdentityRoutes(app, { identity, sessions, settings });

  return app;
}
