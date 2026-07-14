import { describe, it, expect } from "vitest";
import { shellHtml, artifactCsp, shellCsp } from "./visual-shell.js";

const ORIGIN = "https://portico.example";

describe("visual shell", () => {
  it("frames the artifact with allow-scripts and never allow-same-origin", () => {
    const html = shellHtml("Pod restarts", "/visual/abc/raw");
    expect(html).toContain('sandbox="allow-scripts"');
    // The one invariant that matters: together, these two let the framed page
    // remove its own sandbox attribute.
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain('src="/visual/abc/raw"');
  });

  it("escapes the title so an artifact title cannot inject markup into the shell", () => {
    const html = shellHtml("</title><script>alert(1)</script>", "/visual/abc/raw");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("carries no script of its own", () => {
    expect(shellCsp(ORIGIN)).toContain("script-src 'none'");
  });

  it("lets the artifact run script from inline and our own origin, and reach nothing", () => {
    const csp = artifactCsp(ORIGIN);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src 'unsafe-inline' 'self' ${ORIGIN}`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("http://"); // no external origin, ever
    // frame-ancestors 'none' would block our OWN shell from framing it.
    expect(csp).toContain(`frame-ancestors 'self' ${ORIGIN}`);
    expect(csp).not.toContain("frame-ancestors 'none'");
  });
});
