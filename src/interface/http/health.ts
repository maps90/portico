import type { Express, Request, Response } from "express";
import type { Pool } from "pg";

/**
 * Liveness (`/healthz`) and readiness (`/readyz`) endpoints.
 * Readiness pings Postgres, mirroring jean's `health.py`.
 */
export function registerHealth(app: Express, pool: Pool | null): void {
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (_req: Request, res: Response) => {
    if (!pool) {
      res.status(200).json({ status: "ready", db: "skipped" });
      return;
    }
    try {
      await pool.query("SELECT 1");
      res.status(200).json({ status: "ready", db: "ok" });
    } catch (err) {
      res.status(503).json({ status: "unready", db: String(err) });
    }
  });
}
