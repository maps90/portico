# Vendored browser libraries

Served at `/vendor/<file>`, unauthenticated, `immutable` cached, and referenced by
published visuals. **Never modify or delete a file here** — a visual published against
`echarts-5.6.0.min.js` will load that exact path forever. To upgrade, add a new
version-pinned file alongside the old one.

Not fetched from a CDN and not integrity-checked with SRI, because the artifact CSP
permits no external origin at all — these bytes are same-origin and deployed with the app.

## Bundle format (verified by inspection, not by trusting the package's advertised format)

- **`echarts-5.6.0.min.js`** — genuine UMD. The file opens with a classic UMD wrapper
  (`"object"==typeof exports&&"undefined"!=typeof module?e(exports):"function"==typeof
  define&&define.amd?define(...):e((...globalThis...).echarts={})`). Loaded with a plain
  `<script src="/vendor/echarts-5.6.0.min.js"></script>`, it defines the global `echarts`.

- **`mermaid-11.4.1.min.js`** — **not** the classic UMD pattern, but still safe to load as
  a plain script. Unlike the brief's assumption, this is an esbuild-bundled IIFE (starts
  with `"use strict";var __esbuild_esm_mermaid=(()=>{...`, no top-level `export{`/`import{`
  — confirmed by inspecting the head of the file, so it is not an ES module). At the very
  end of the file it unconditionally runs `globalThis.mermaid =
  globalThis.__esbuild_esm_mermaid.default;`. Net effect: a plain
  `<script src="/vendor/mermaid-11.4.1.min.js"></script>` (NOT `type="module"`) defines
  the global `mermaid`, exactly like the ECharts bundle. No `.esm.min.mjs` fallback was
  needed — the `dist/mermaid.min.js` URL from `unpkg` resolved and produced a
  globally-scoped bundle.

| File | Source | sha256 | Global |
|---|---|---|---|
| `echarts-5.6.0.min.js` | https://unpkg.com/echarts@5.6.0/dist/echarts.min.js | `bf4a223524e40b77c304bec67e1222cf551f14880cf42c69dc046558e11c07b1` | UMD → `echarts` |
| `mermaid-11.4.1.min.js` | https://unpkg.com/mermaid@11.4.1/dist/mermaid.min.js | `a43bc1afd446f9c4cc66ac5dd45d02e8d65e26fc5344ec0ef787f88d6ddb6f9e` | IIFE (global-assigning, not classic UMD) → `mermaid` |

Both libraries load with a plain classic `<script src="...">` tag — neither requires
`type="module"`.
