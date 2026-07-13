import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev: Vite serves the portal on 5173 and proxies every server-owned path to the
 * API on 8080, so the browser sees one origin and the session cookie just works.
 * Build: emits to `web/dist`, which Express serves at `/` in production.
 */
const API = process.env.PORTICO_API_URL ?? "http://localhost:8080";
const proxied = ["/api", "/login", "/logout", "/auth", "/connect", "/a", "/healthz"];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      proxied.map((path) => [path, { target: API, changeOrigin: false }]),
    ),
  },
  build: { outDir: "dist", emptyOutDir: true },
});
