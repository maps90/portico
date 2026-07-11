/** Tiny server-rendered HTML helpers for the login/token/error pages. */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 15px/1.6 -apple-system, system-ui, sans-serif; max-width: 640px;
         margin: 6vh auto; padding: 0 1.2rem; color: #1c2530; }
  h1 { font-size: 1.4rem; }
  code, pre { background: #f2f4f7; border-radius: 6px; }
  code { padding: .15em .4em; }
  pre { padding: 1rem; overflow-x: auto; user-select: all; }
  .muted { color: #667085; }
  a.btn { display: inline-block; background: #1570ef; color: #fff; text-decoration: none;
          padding: .6rem 1rem; border-radius: 8px; }
</style></head><body>${bodyHtml}</body></html>`;
}
