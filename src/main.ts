import pg from "pg";
import { loadConfig } from "./config.js";
import { createApp } from "./interface/http/server.js";
import { ensureSchema } from "./adapters/db/schema.js";

/**
 * Process entry point. Loads config, opens the Postgres pool, and starts the
 * HTTP server. Kept thin: all wiring lives in the composition root (createApp).
 */
async function main(): Promise<void> {
  const settings = loadConfig(process.env);

  let pool: pg.Pool | null = null;
  if (settings.databaseUrl) {
    pool = new pg.Pool({ connectionString: settings.databaseUrl });
    await ensureSchema(pool);
    console.log("portico using Postgres store");
  } else {
    console.warn("portico PORTICO_DATABASE_URL unset — using in-memory stores (non-persistent)");
  }

  const app = createApp({ settings, pool });

  const server = app.listen(settings.port, () => {
    console.log(`portico listening on ${settings.baseUrl} (port ${settings.port})`);
  });

  const shutdown = (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => {
      void (pool ? pool.end() : Promise.resolve()).then(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
