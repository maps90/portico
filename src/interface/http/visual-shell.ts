import { escapeHtml } from "./html.js";

/**
 * The trusted chrome around an untrusted artifact.
 *
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin` gives the framed document an
 * opaque origin: its script cannot read portico's session cookie or localStorage, cannot
 * see this document, and — with no `allow-top-navigation` — cannot redirect the tab to
 * an attacker's URL. Granting both `allow-scripts` and `allow-same-origin` would let the
 * page reach into its own DOM and delete this very attribute. Never add it.
 *
 * The shell itself contains no script, which is why its CSP can say `script-src 'none'`.
 */
export function shellHtml(title: string, rawPath: string): string {
  const t = escapeHtml(title);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column;
         font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #1c2530; }
  header { flex: 0 0 auto; display: flex; align-items: baseline; gap: .6rem;
           padding: .7rem 1rem; border-bottom: 1px solid #e4e7ec; }
  header b { font-weight: 600; }
  header span { color: #667085; font-size: 12px; }
  iframe { flex: 1 1 auto; width: 100%; border: 0; }
</style></head>
<body>
  <header><b>${t}</b><span>portico</span></header>
  <iframe src="${escapeHtml(rawPath)}" sandbox="allow-scripts" title="${t}"></iframe>
</body></html>`;
}

/**
 * CSP for the untrusted artifact document.
 *
 * Script is allowed — inline (so an agent can configure a chart with real data) and from
 * our own origin (the vendored bundles). Egress is not: `connect-src 'none'` kills
 * fetch/XHR/WebSocket/sendBeacon, and because no external origin appears anywhere, there
 * is no `<script src="//attacker/?d=…">` channel either. Script runs; nothing leaves.
 *
 * Both `'self'` and the explicit origin are listed: `'self'` is unreliable in an
 * opaque-origin sandbox, and the explicit origin can miss when a deployment's baseUrl and
 * its actual served origin differ (dev ports). Listing both is belt and braces.
 */
export function artifactCsp(origin: string): string {
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'self' ${origin}`,
    `style-src 'unsafe-inline' 'self' ${origin}`,
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // NOT 'none' — that would block our own shell from framing this document.
    `frame-ancestors 'self' ${origin}`,
  ].join("; ");
}

/** CSP for the trusted shell, which has no script and loads nothing but its own frame. */
export function shellCsp(origin: string): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    `frame-src 'self' ${origin}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
