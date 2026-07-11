import pg from "pg";
import { loadConfig } from "./config.js";
import { createApp } from "./interface/http/server.js";

/**
 * Process entry point. Loads config, opens the Postgres pool, and starts the
 * HTTP server. Kept thin: all wiring lives in the composition root (createApp).
 */
async function main(): Promise<void> {
  const settings = loadConfig(process.env);
  const pool = new pg.Pool({ connectionString: settings.databaseUrl });

  const app = createApp({ settings, pool });

  const server = app.listen(settings.port, () => {
    console.log(`omni-mcp listening on ${settings.baseUrl} (port ${settings.port})`);
  });

  const shutdown = (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
