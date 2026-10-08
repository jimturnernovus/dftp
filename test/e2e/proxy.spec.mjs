// Proxy mode in a real browser: the layer's script loads under the page's own
// CSP, WebSockets work from the frame origin and nowhere else, the designer
// edits and saves a proxied single-page app and notices when the app moves to
// another path, other sites cannot frame the page, and a redirect to another
// host goes nowhere.
//
// The last test runs against a real Vite dev server when DFTP_VITE_EXAMPLE
// names a copy of examples/vite-react with its packages installed (the copy
// must keep ../../plugins next to it); it is skipped otherwise.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { startApp, sleep, tempRoot, removeRoot, mtimeOf, docPath } from "../helpers.mjs";
import { startUpstream, wsConnect } from "../fixtures/upstream.mjs";
import { startCapture } from "../fixtures/capture.mjs";
import { openDesigner, clickIn, dragIn, rectOf, readDoc, saves, waitSaved, setMode } from "./helpers.mjs";

let up;
let app;

test.beforeAll(async () => {
  up = await startUpstream();
  app = await startApp({ flags: { demo: false, target: up.origin } });
});

test.afterAll(async () => {
  await app.close();
  await up.close();
});

// Every request and WebSocket the page opens, to prove nothing leaves the
// frame origin.
function watch(page) {
  const urls = [];
  const csp = [];
  page.on("request", (r) => urls.push(r.url()));
  page.on("websocket", (ws) => urls.push(ws.url()));
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text());
  });
  return { urls, csp };
}

test("the layer script loads under the page's own nonce + strict-dynamic policy", async ({ page }) => {
  const seen = watch(page);
  const layer = page.waitForResponse((r) => r.url() === `${app.frameOrigin}/__dftp/overlay.js`);
  await page.goto(`${app.frameOrigin}/nonce`);
  expect((await layer).status()).toBe(200);
  await expect(page.locator("h1")).toHaveText("Nonce page");
  expect(await page.evaluate(() => document.documentElement.dataset.inline)).toBe("ran");
  await page.waitForLoadState("networkidle");
  expect(seen.urls.some((u) => u === `${app.frameOrigin}/__dftp/core/overlay.js`)).toBe(true);
  expect(seen.csp.filter((t) => t.includes("__dftp"))).toEqual([]);
  expect(seen.urls.every((u) => u.startsWith(app.frameOrigin))).toBe(true);
});

test("a page with default-src 'self' loads the layer too, and opened directly it just works", async ({ page }) => {
  const seen = watch(page);
  await page.goto(`${app.frameOrigin}/page`);
  await expect(page.locator("h1")).toHaveText("Upstream page");
  await page.waitForLoadState("networkidle");
  expect(seen.urls).toContain(`${app.frameOrigin}/__dftp/overlay.js`);
  expect(seen.csp.filter((t) => t.includes("__dftp"))).toEqual([]);
});

test("a WebSocket from the frame origin echoes; one from another origin never reaches the dev server", async ({ page }) => {
  await page.goto(`${app.frameOrigin}/page`);
  const echo = await page.evaluate((url) => new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (e) => {
      resolve(e.data);
      ws.close();
    };
    ws.onerror = () => resolve("error");
  }), `${app.frameOrigin.replace("http:", "ws:")}/ws`);
  expect(echo).toBe("echo:ping");
  const before = up.upgrades.length;

  const other = await startCapture({ pageHtml: "<!doctype html><title>other site</title><p>other</p>" });
  try {
    await page.goto(`${other.origin}/`);
    const result = await page.evaluate((url) => new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("error");
    }), `${app.frameOrigin.replace("http:", "ws:")}/ws`);
    expect(result).toBe("error");
    await sleep(100);
    expect(up.upgrades.length).toBe(before);
  } finally {
    await other.close();
  }

  // A client that can set any Origin it likes is closed just the same.
  const foreign = await wsConnect(app.framePort, { path: "/ws", headers: { Origin: "http://evil.example" } });
  expect(foreign.status).not.toBe(101);
  await sleep(100);
  expect(up.upgrades.length).toBe(before);
  const right = await wsConnect(app.framePort, { path: "/ws", headers: { Origin: app.frameOrigin } });
  try {
    expect(right.status).toBe(101);
    right.send("raw");
    expect(await right.next()).toBe("echo:raw");
  } finally {
    right.close();
  }
});

// The whole designer in front of a proxied single-page app.
const NEAR = 2.5;
function near(actual, expected) {
  expect(Math.abs(actual - expected), `${actual} should be within ${NEAR} of ${expected}`).toBeLessThanOrEqual(NEAR);
}

test("in the designer: the layer starts in the proxied app, a drag saves, an in-app link elsewhere shows the left-the-page bar", async ({ browser }) => {
  const root = await tempRoot({ demo: false });
  const d = await openDesigner(browser, { root, flags: { demo: false, target: up.origin, pages: ["/spa"] } });
  try {
    // The app sends X-Frame-Options DENY and frame-ancestors 'none'; the
    // designer still shows it, with the layer running inside.
    expect(d.frame.url()).toBe(`${d.app.frameOrigin}/spa`);
    await expect.poll(() => d.frame.evaluate(() => document.querySelectorAll("dftp-layer").length)).toBe(1);
    await expect(d.frame.locator("#view .lead")).toHaveText("The start view.");
    await expect(d.page.locator("body")).toHaveAttribute("data-current-mode", "design");
    await expect(d.page.locator("#nolayer-note")).toBeHidden();

    // A drag is saved under the page and device the designer chose.
    await clickIn(d.page, d.frame, "h1");
    await expect(d.page.locator("#picked")).toContainText("Small app");
    const start = await rectOf(d.frame, "h1");
    const n = await saves(d.page);
    await dragIn(d.page, d.frame, "h1", 30, 12);
    await waitSaved(d.page, n);
    const moved = await rectOf(d.frame, "h1");
    near(moved.x - start.x, 30);
    near(moved.y - start.y, 12);
    const doc = readDoc(root, "spa", "desktop");
    expect(doc.list).toHaveLength(1);
    const c = doc.list[0];
    expect(c.tag).toBe("h1");
    expect(c.text).toBe("Small app");
    expect(c.loc).toBe("");
    near(c.dx, 30);
    near(c.dy, 12);
    const md = await fsp.readFile(path.join(root, ".dftp", "CHANGES.md"), "utf8");
    expect(md).toContain(`[${c.id}]`);
    expect(md).toContain("\"Small app\"");

    // A change on what the app draws late is not on the page when the layer
    // starts; once the app draws it, it is put back and the list stops
    // calling it missing.
    const leadStart = await rectOf(d.frame, "#view .lead");
    const n2 = await saves(d.page);
    await dragIn(d.page, d.frame, "#view .lead", 20, 6);
    await waitSaved(d.page, n2);
    expect(readDoc(root, "spa", "desktop").list).toHaveLength(2);
    const posted = d.posts.length;
    await d.page.locator("#reload-page").click();
    await expect(d.page.locator("#canvas")).toHaveAttribute("data-loaded", "1");
    await expect(d.frame.locator("#view .lead")).toHaveText("The start view.");
    await expect(d.page.locator("#change-list li[data-id]")).toHaveCount(2);
    await expect(d.page.locator("#change-list li.is-missing")).toHaveCount(0);
    near((await rectOf(d.frame, "#view .lead")).x - leadStart.x, 20);
    near((await rectOf(d.frame, "h1")).x - start.x, 30);
    await sleep(300);
    expect(d.posts.length).toBe(posted);

    // A WebSocket from inside the designed page reaches the dev server.
    const echo = await d.frame.evaluate(() => new Promise((resolve) => {
      const ws = new WebSocket(`${location.origin.replace("http:", "ws:")}/ws`);
      ws.onopen = () => ws.send("from the frame");
      ws.onmessage = (e) => {
        resolve(e.data);
        ws.close();
      };
      ws.onerror = () => resolve("error");
    }));
    expect(echo).toBe("echo:from the frame");

    // The app's own link moves to a path that is not one of the designer's
    // pages: the bar shows, the change comes off, nothing is saved there.
    const file = docPath(root, "spa", "desktop");
    const savedAt = await mtimeOf(file);
    const posts = d.posts.length;
    await setMode(d.page, "use");
    await clickIn(d.page, d.frame, "#other");
    await expect(d.page.locator("#away-note")).toBeVisible();
    await expect(d.page.locator("#away-msg")).toContainText("/spa/other");
    await expect(d.frame.locator("#view .lead")).toHaveText("The other view.");
    expect(d.frame.url()).toBe(`${d.app.frameOrigin}/spa/other`);
    await expect.poll(async () => (await rectOf(d.frame, "h1")).x).toBeCloseTo(start.x, 0);
    near((await rectOf(d.frame, "h1")).y, start.y);
    await d.page.locator("[data-set-mode=\"design\"]").click();
    await expect(d.page.locator("body")).toHaveAttribute("data-current-mode", "use");

    // Back reopens the designer's page with the change on again.
    await expect(d.page.locator("#away-return")).toHaveText("Back to /spa");
    await d.page.locator("#away-return").click();
    await expect(d.page.locator("#away-note")).toBeHidden();
    await expect(d.page.locator("#canvas")).toHaveAttribute("data-loaded", "1");
    expect(d.frame.url()).toBe(`${d.app.frameOrigin}/spa`);
    await expect.poll(async () => (await rectOf(d.frame, "h1")).x - start.x).toBeGreaterThan(30 - NEAR);
    near((await rectOf(d.frame, "h1")).y - start.y, 12);
    expect(d.posts.length).toBe(posts);
    expect(await mtimeOf(file)).toBe(savedAt);
  } finally {
    await d.close();
    await removeRoot(root);
  }
});

test("another origin cannot frame the proxied page", async ({ page }) => {
  const seen = watch(page);
  // The second frame is a control: the same kind of page straight from the
  // dev server, which sets no framing rule, does load.
  const other = await startCapture({
    pageHtml: `<!doctype html><title>framer</title><iframe src="${app.frameOrigin}/page"></iframe><iframe src="${up.origin}/landing"></iframe>`,
  });
  try {
    await page.goto(`${other.origin}/`);
    await page.waitForLoadState("networkidle");
    const titles = await Promise.all(page.frames().filter((f) => f !== page.mainFrame()).map((f) =>
      f.evaluate(() => document.title).catch(() => "")));
    expect(titles).toContain("Landing");
    expect(titles).not.toContain("Upstream page");
    expect(seen.csp.some((t) => t.includes(`frame-ancestors ${app.shellOrigin}`))).toBe(true);
  } finally {
    await other.close();
  }
});

test("a redirect to another host shows a notice with no link and goes nowhere", async ({ page }) => {
  const other = await startCapture();
  try {
    await page.goto(`${app.frameOrigin}/redirect/to?u=${encodeURIComponent(`${other.origin}/elsewhere`)}`);
    await expect(page.locator("body")).toContainText(`This page tried to go to 127.0.0.1:${other.port}, outside your dev server.`);
    expect(page.url().startsWith(app.frameOrigin)).toBe(true);
    expect(await page.evaluate(() => document.links.length + document.scripts.length + document.forms.length)).toBe(0);
    await sleep(200);
    expect(other.connections()).toBe(0);
  } finally {
    await other.close();
  }
});

// ---------------------------------------------------------------- real Vite (optional)

const viteDir = process.env.DFTP_VITE_EXAMPLE || "";
const VITE_TEST_MS = 60000;
const viteBin = viteDir ? path.join(viteDir, "node_modules", "vite", "bin", "vite.js") : "";

test("Vite example: stamped elements, a saved drag, HMR through the proxy with the change kept, nothing outside the frame origin", async ({ browser, page }) => {
  test.skip(!viteBin || !fs.existsSync(viteBin), "set DFTP_VITE_EXAMPLE to an installed copy of examples/vite-react");
  test.setTimeout(VITE_TEST_MS);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: viteDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development" },
  });
  let out = "";
  vite.stdout.on("data", (d) => {
    out += d;
  });
  vite.stderr.on("data", (d) => {
    out += d;
  });
  const appFile = path.join(viteDir, "src", "App.jsx");
  const original = await fsp.readFile(appFile, "utf8");
  let d = null;
  try {
    for (let i = 0; i < 100 && !out.includes(`${port}`); i++) await sleep(100);
    d = await openDesigner(browser, { root: viteDir, flags: { demo: false, target: `http://127.0.0.1:${port}` } });
    const t = d.app;

    // The page on its own, at the frame origin: stamped by the Babel plugin.
    const seen = watch(page);
    const connected = page.waitForEvent("console", { predicate: (m) => m.text().includes("[vite] connected"), timeout: 15000 });
    await page.goto(`${t.frameOrigin}/`);
    await connected;
    const h1 = page.locator("h1");
    await expect(h1).toHaveText("Pick a plan");
    expect(await h1.getAttribute("data-loc")).toMatch(/^src\/App\.jsx:\d+:\d+$/);
    expect(await page.locator("button").first().getAttribute("data-loc")).toMatch(/^src\/components\/ui\/button\.jsx:\d+:\d+$/);
    expect(seen.urls).toContain(`${t.frameOrigin}/__dftp/overlay.js`);

    // In the designer: a drag on the heading is saved in the project's own
    // .dftp folder under the heading's source location.
    await d.page.locator("#reload-page").click();
    await expect(d.page.locator("#canvas")).toHaveAttribute("data-loaded", "1", { timeout: 15000 });
    await expect(d.frame.locator("h1")).toHaveText("Pick a plan");
    const loc = await d.frame.locator("h1").getAttribute("data-loc");
    expect(loc).toMatch(/^src\/App\.jsx:\d+:\d+$/);
    // A copy used before may hold changes already; they are back on the page
    // once React has drawn it and the list calls none of them missing.
    const prior = readDoc(viteDir, "home", "desktop");
    const priorChange = prior ? prior.list.find((c) => c.loc === loc && !c.part) : null;
    await expect(d.page.locator("#change-list li[data-id]")).toHaveCount(prior ? prior.list.length : 0);
    await expect(d.page.locator("#change-list li.is-missing")).toHaveCount(0);
    const start = await rectOf(d.frame, "h1");
    await clickIn(d.page, d.frame, "h1");
    await expect(d.page.locator("#picked")).toContainText("src/App.jsx:");
    const n = await saves(d.page);
    await dragIn(d.page, d.frame, "h1", 25, 10);
    await waitSaved(d.page, n);
    const doc = readDoc(viteDir, "home", "desktop");
    const c = doc.list.find((x) => x.loc === loc && !x.part);
    expect(c).toBeTruthy();
    near(c.dx, (priorChange ? priorChange.dx : 0) + 25);
    near(c.dy, (priorChange ? priorChange.dy : 0) + 10);
    expect(c.src).toMatch(/^[0-9a-f]{12}$/);
    expect(fs.existsSync(path.join(viteDir, ".dftp", "CHANGES.md"))).toBe(true);

    // HMR: an edit elsewhere in the same source file (the line under the
    // heading, same line count) reaches both pages through the proxy, and the
    // designer keeps the change on the heading, whose own line and words are
    // unchanged. (Editing the heading's own words is a different case: then
    // the change waits for review, by design.)
    const edited = original.replace("Every name and price is invented.", "Every name and price here is invented.");
    expect(edited).not.toBe(original);
    await fsp.writeFile(appFile, edited);
    await expect(page.locator("p.lead")).toContainText("price here is invented", { timeout: 15000 });
    await expect(d.frame.locator("p.lead")).toContainText("price here is invented", { timeout: 15000 });
    await expect(d.frame.locator("h1")).toHaveText("Pick a plan");
    await expect.poll(async () => Math.round((await rectOf(d.frame, "h1")).x - start.x), { timeout: 15000 }).toBeGreaterThanOrEqual(25 - NEAR);
    await expect(d.page.locator("#change-list li.is-missing")).toHaveCount(0);
    near((await rectOf(d.frame, "h1")).x - start.x, 25);
    near((await rectOf(d.frame, "h1")).y - start.y, 10);
    expect(seen.urls.every((u) => u.startsWith(t.frameOrigin) || u.startsWith(t.frameOrigin.replace("http:", "ws:")))).toBe(true);
  } finally {
    await fsp.writeFile(appFile, original);
    if (d) await d.close();
    vite.kill("SIGTERM");
    await sleep(200);
    if (vite.exitCode === null) vite.kill("SIGKILL");
  }
});
