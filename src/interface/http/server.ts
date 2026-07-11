import express, { type Express } from "express";
import type { Pool } from "pg";
import type { Settings } from "../../config.js";
import { registerHealth } from "./health.js";

export interface Dependencies {
  settings: Settings;
  pool: Pool | null;
}

/**
 * Composition root. Builds the Express app and wires the interface layer.
 *
 * Milestone 1 mounts only health checks; later milestones register the identity
 * routes, the `/mcp` Streamable HTTP endpoint, the `/connect/*` upstream OAuth
 * flow, and the `/a/:id` artifact viewer here — each behind an application
 * service that depends only on ports.
 */
export function createApp(deps: Dependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));

  registerHealth(app, deps.pool);

  return app;
}
