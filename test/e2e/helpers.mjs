// Shared helpers for the browser tests: start the designer on random loopback
// ports with a throwaway copy of the demo, open it in a fresh browser
// context, and move the mouse in the framed page's own coordinates.

import "../no-net.mjs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { startApp, tempRoot, removeRoot, docPath, TOOL_DIR } from "../helpers.mjs";
import { validateDoc } from "../../client/core/schema.js";

export { expect, docPath, TOOL_DIR, tempRoot, removeRoot };

export const FIXTURES = path.join(TOOL_DIR, "test", "e2e", "fixtures");

// A project folder whose demo page is `page` (a fixture file name), or the
// real demo when no page is given.
export async function rootWith(page) {
  const dir = await tempRoot({ demo: true });
  if (page) await fsp.copyFile(path.join(FIXTURES, page), path.join(dir, "demo", "active-clients.html"));
  return dir;
}

// Start servers and open the designer. Returns a handle with page, frame,
// the list of POSTs seen, dialogs seen, and close().
export async function openDesigner(browser, opts = {}) {
  const root = opts.root || (await rootWith(opts.page));
  const ownRoot = !opts.root;
  const logs = [];
  const app = await startApp({ root, flags: opts.flags || {}, log: (line) => logs.push(line), keepRoot: true });
  let d;
  try {
    d = await openWindow(browser, app, opts);
  } catch (e) {
    await app.close();
    if (ownRoot) await removeRoot(root);
    throw e;
  }
  d.app = app;
  d.root = root;
  d.logs = logs;
  d.close = async () => {
    await d.context.close().catch(() => {});
    await app.close();
    await idle(app);
    if (ownRoot && !opts.keepRoot) await removeRoot(root);
  };
  return d;
}

// Wait for any save still being written when the servers closed.
export async function idle(app) {
  await app.app.store.withLock(async () => {}).catch(() => {});
}

// Another designer window on the same servers.
export async function openWindow(browser, app, opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, acceptDownloads: true });
  // The browser may talk only to this computer.
  await context.route(/^(?!http:\/\/127\.0\.0\.1[:/])[a-z]+:\/\//i, (route) => route.abort());
  if (opts.prefs) {
    await context.addInitScript(([k, v]) => {
      try {
        if (!localStorage.getItem(k)) localStorage.setItem(k, v);
      } catch {
        // storage refused
      }
    }, ["dftp-prefs", JSON.stringify(opts.prefs)]);
  }
  const page = await context.newPage();
  const posts = [];
  const dialogs = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push({ url: r.url(), at: Date.now() });
  });
  if (process.env.DFTP_E2E_DEBUG) {
    page.on("console", (m) => process.stdout.write(`[console ${m.type()}] ${m.text()} @ ${m.location().url}\n`));
    page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${e.message}\n`));
    page.on("requestfailed", (r) => process.stdout.write(`[requestfailed] ${r.url()} ${r.failure() && r.failure().errorText}\n`));
  }
  page.on("dialog", (dlg) => {
    dialogs.push(dlg.message());
    dlg.dismiss().catch(() => {});
  });
  await page.goto(app.link);
  await waitLoaded(page);
  return {
    context,
    page,
    posts,
    dialogs,
    // The frame is replaced on every load, so this is looked up each time.
    get frame() {
      return frameOf(page);
    },
  };
}

export function frameOf(page) {
  const f = page.frames().find((x) => x.parentFrame() === page.mainFrame());
  if (!f) throw new Error("no frame");
  return f;
}

export async function waitLoaded(page, timeout = 15000) {
  await expect(page.locator("#canvas")).toHaveAttribute("data-loaded", "1", { timeout });
}

// The number of saves this window finished.
export const saves = async (page) => Number(await page.locator("#save-state").getAttribute("data-saves"));

export async function waitSaved(page, after, timeout = 8000) {
  await expect.poll(async () => (await saves(page)) > after && (await page.locator("#save-state").getAttribute("data-state")) === "saved", { timeout }).toBe(true);
}

export function readDoc(root, page = "active-clients", device = "desktop") {
  const file = docPath(root, page, device);
  if (!fs.existsSync(file)) return null;
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const v = validateDoc(doc, { page, device });
  if (!v.ok) throw new Error(`saved file is not valid: ${v.error}`);
  return v.value;
}

// Where the frame sits in the window and how far it is scaled.
export async function geometry(page) {
  return page.evaluate(() => {
    const f = document.getElementById("page-frame");
    const r = f.getBoundingClientRect();
    return { x: r.left, y: r.top, k: r.width / f.offsetWidth };
  });
}

export async function rectOf(frame, selector) {
  return frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
}

// Window coordinates of a point given in the frame's own pixels.
export function toWindow(g, x, y) {
  return { x: g.x + x * g.k, y: g.y + y * g.k };
}

export async function centerOf(page, frame, selector, dx = 0.5, dy = 0.5) {
  const g = await geometry(page);
  const r = await rectOf(frame, selector);
  if (!r) throw new Error(`no element ${selector}`);
  return toWindow(g, r.x + r.w * dx, r.y + r.h * dy);
}

export async function clickIn(page, frame, selector, opts = {}) {
  const p = await centerOf(page, frame, selector, opts.fx ?? 0.5, opts.fy ?? 0.5);
  for (const m of opts.modifiers || []) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y);
  for (const m of opts.modifiers || []) await page.keyboard.up(m);
}

// Drag from a point of an element by (dx, dy) frame pixels.
export async function dragIn(page, frame, selector, dx, dy, opts = {}) {
  const g = await geometry(page);
  const r = await rectOf(frame, selector);
  const sx = r.x + r.w * (opts.fx ?? 0.5);
  const sy = r.y + r.h * (opts.fy ?? 0.5);
  return dragFrom(page, g, sx, sy, dx, dy, opts);
}

export async function dragFrom(page, g, sx, sy, dx, dy, opts = {}) {
  const a = toWindow(g, sx, sy);
  const b = toWindow(g, sx + dx, sy + dy);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  const steps = opts.steps ?? 4;
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  await page.mouse.up();
}

// Post a message to the layer as the designer window would (the nonce is
// the frame's name). For tests of what the layer accepts.
export async function postToLayer(page, frameOrigin, messages) {
  await page.evaluate(([origin, list]) => {
    const f = document.getElementById("page-frame");
    const n = f.name.slice(f.name.indexOf(":") + 1);
    for (const m of list) f.contentWindow.postMessage({ dftp: 1, n, ...m }, origin);
  }, [frameOrigin, messages]);
}

// Wait until the layer has handled every message the designer window sent
// before this call: messages between two windows arrive in order, so the
// answer to a "flush" sent now comes after all of them.
export async function syncLayer(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const f = document.getElementById("page-frame");
    const n = f.name.slice(f.name.indexOf(":") + 1);
    const timer = setTimeout(resolve, 3000);
    const done = (e) => {
      if (e.source === f.contentWindow && e.data && e.data.type === "flushed") {
        removeEventListener("message", done);
        clearTimeout(timer);
        resolve();
      }
    };
    addEventListener("message", done);
    f.contentWindow.postMessage({ dftp: 1, n, type: "flush" }, new URL(f.src).origin);
  }));
}

export async function listIds(page) {
  return page.locator("#change-list li[data-id]").evaluateAll((lis) => lis.map((li) => li.dataset.id));
}

export async function setDevice(page, id) {
  await page.locator(`[data-screen="${id}"]`).click();
  await waitLoaded(page);
}

export async function setMode(page, mode) {
  await page.locator(`[data-set-mode="${mode}"]`).click();
  await waitMode(page, mode);
}

// The window's mode and the layer's (which hears of it by message).
export async function waitMode(page, mode) {
  await expect(page.locator("body")).toHaveAttribute("data-current-mode", mode);
  await expect.poll(() => frameOf(page).evaluate(() => document.documentElement.classList.contains("dftp-design"))).toBe(mode === "design");
}

export async function walkFiles(dir) {
  const out = [];
  async function walk(d) {
    let ents;
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  }
  await walk(dir);
  return out;
}

// The box of one word inside an element's text, in frame pixels.
export async function wordRect(frame, selector, word) {
  return frame.evaluate(([sel, w]) => {
    const el = document.querySelector(sel);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.nodeValue.indexOf(w);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    }
    return null;
  }, [selector, word]);
}

// The saved change whose element matches a selector (by its source location).
export async function changeFor(root, frame, selector, device = "desktop") {
  const loc = await frame.evaluate((sel) => document.querySelector(sel).getAttribute("data-loc"), selector);
  const doc = readDoc(root, "active-clients", device);
  return doc ? doc.list.find((c) => c.loc === loc && !c.part) || null : null;
}

// null while the frame is being replaced (a reload), so polls simply retry.
export const translateOf = (frame, selector) => frame.evaluate((sel) => getComputedStyle(document.querySelector(sel)).translate, selector).catch(() => null);

// The text editor sits in the layer's closed shadow root; while it has the
// focus, the page's active element is the layer's host.
export async function waitEditor(frameGetter, open = true) {
  await expect.poll(() => frameGetter().evaluate(() => !!document.activeElement && document.activeElement.localName === "dftp-layer")).toBe(open);
}
