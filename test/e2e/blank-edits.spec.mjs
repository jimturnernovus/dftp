// Editing on blank pages, in the real designer: the palette's hint never
// moves the preview, the palette saves an open text editor first, a new
// element dragged out of its box goes where it was dropped, a size filled
// in from another records its own box on the first resize, a button label
// stays readable in dark mode, an image placeholder shows on a page drawn in
// the surface color, and --blank opens on the blank page even when the
// config file names a dev server that is not running.

import { test } from "@playwright/test";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  openDesigner, expect, tempRoot, TOOL_DIR, geometry, toWindow, rectOf, clickIn, dragIn, saves, waitSaved,
  readDoc, setDevice, waitEditor, syncLayer,
} from "./helpers.mjs";

const LONG_TEST_MS = 90000;
const PROJECTS = path.join(TOOL_DIR, "test", "fixtures", "projects");
const FIXTURE = path.join(PROJECTS, "tailwind-v4");

async function open(browser, { files = null, fixture = FIXTURE, flags = { demo: false, blank: [null] }, viewport } = {}) {
  const root = await tempRoot({ demo: false });
  if (files) {
    for (const [rel, text] of Object.entries(files)) {
      await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fsp.writeFile(path.join(root, rel), text);
    }
  } else await fsp.cp(fixture, root, { recursive: true });
  const d = await openDesigner(browser, { root, flags, viewport, keepRoot: false });
  const close = d.close;
  d.close = async () => {
    await close();
    await fsp.rm(root, { recursive: true, force: true });
  };
  return d;
}

const inserts = (d, device = "desktop") => {
  const x = readDoc(d.root, "blank", device);
  return x ? x.list.filter((c) => c.kind === "insert") : [];
};
const sel = (c) => `[data-dftp-ins="${c.id}"]`;

async function clickPalette(d, kind) {
  const n = await saves(d.page);
  await d.page.locator(`[data-insert="${kind}"]`).click();
  await waitSaved(d.page, n);
}

test.describe("editing on blank pages", () => {
  test.setTimeout(LONG_TEST_MS);

  test("picking a box never changes the palette bar's height, so the preview stays put under the pointer", async ({ browser }) => {
    const d = await open(browser, { viewport: { width: 1440, height: 900 } });
    try {
      await clickPalette(d, "grid");
      await clickPalette(d, "card");
      await d.page.keyboard.press("Escape");
      const card = inserts(d).find((c) => c.element === "card");
      const bar = () => d.page.locator("#palette-bar").evaluate((n) => n.getBoundingClientRect().height);
      const frameTop = () => d.page.locator("#page-frame").evaluate((n) => n.getBoundingClientRect().top);
      const h0 = await bar();
      const y0 = await frameTop();
      await clickIn(d.page, d.frame, sel(card), { fx: 0.5, fy: 0.5 });
      await expect(d.page.locator("#palette-bar .pal-hint")).toContainText("into the selected card");
      expect(await bar()).toBe(h0);
      expect(await frameTop()).toBe(y0);
      await expect(d.page.locator("#palette-bar .pal-hint")).toHaveAttribute("title", /into the selected card/);
    } finally {
      await d.close();
    }
  });

  test("adding an element while the text editor is open saves the editor first", async ({ browser }) => {
    const d = await open(browser);
    try {
      await clickPalette(d, "heading");
      const [heading] = inserts(d);
      await clickIn(d.page, d.frame, sel(heading), { fx: 0.2, fy: 0.5 });
      await d.page.keyboard.press("e");
      await waitEditor(() => d.frame);
      await d.page.keyboard.press("ControlOrMeta+a");
      await d.page.keyboard.type("Welcome");
      await clickPalette(d, "text");
      await waitEditor(() => d.frame, false);
      await expect.poll(() => inserts(d).find((c) => c.id === heading.id).text_to).toBe("Welcome");
      expect(await d.frame.locator(sel(heading)).textContent()).toBe("Welcome");
      // The editor now works on the new element.
      const text = inserts(d).find((c) => c.element === "text");
      await d.page.keyboard.press("e");
      await waitEditor(() => d.frame);
      const n = await saves(d.page);
      await d.page.keyboard.press("ControlOrMeta+a");
      await d.page.keyboard.type("Body copy");
      await d.page.keyboard.press("Enter");
      await waitSaved(d.page, n);
      expect(inserts(d).find((c) => c.id === text.id).text_to).toBe("Body copy");
      expect(inserts(d).find((c) => c.id === heading.id).text_to).toBe("Welcome");
    } finally {
      await d.close();
    }
  });

  test("a new element dragged out of its card goes onto the page where it was dropped, not kept in the card as an offset", async ({ browser }) => {
    const d = await open(browser);
    try {
      await clickPalette(d, "card");
      await clickPalette(d, "heading");
      await clickPalette(d, "button");
      await d.page.keyboard.press("Escape");
      const card = inserts(d).find((c) => c.element === "card");
      let button = inserts(d).find((c) => c.element === "button");
      expect(button.parent).toBe(card.key);
      const cr = await rectOf(d.frame, sel(card));
      const br = await rectOf(d.frame, sel(button));
      await clickIn(d.page, d.frame, sel(button), { fx: 0.3, fy: 0.5 });
      const n = await saves(d.page);
      // Down and out of the card, into the empty page below it.
      await dragIn(d.page, d.frame, sel(button), 40, cr.y + cr.h - br.y + 60, { fx: 0.3, fy: 0.5, steps: 8 });
      await waitSaved(d.page, n);
      button = inserts(d).find((c) => c.id === button.id);
      expect(button.parent).toBe("scaffold");
      expect(button.index).toBe(1);
      expect(button.dx || 0).toBe(0);
      expect(button.dy || 0).toBe(0);
      expect(button.detached).toBeUndefined();
      await syncLayer(d.page);
      expect(await d.frame.evaluate((q) => document.querySelector(q).parentElement.matches("main[data-dftp-scaffold]"), sel(button))).toBe(true);
      const md = await fsp.readFile(path.join(d.root, ".dftp", "CHANGES.md"), "utf8");
      expect(md).toContain(`[${button.id}] new button <button> "Button" — inside the page's main container, item 2 of 2`);
      expect(md).not.toContain("detached from its container");
    } finally {
      await d.close();
    }
  });

  test("a new element dragged from one card into another goes into that card where it was dropped; undo puts it back", async ({ browser }) => {
    const d = await open(browser);
    try {
      await clickPalette(d, "card");
      await clickPalette(d, "heading");
      await clickPalette(d, "button");
      await d.page.keyboard.press("Escape");
      await clickPalette(d, "card");
      await clickPalette(d, "text");
      await d.page.keyboard.press("Escape");
      const [first, second] = inserts(d).filter((c) => c.element === "card").sort((a, b) => a.index - b.index);
      let button = inserts(d).find((c) => c.element === "button");
      const text = inserts(d).find((c) => c.element === "text");
      expect([button.parent, text.parent]).toEqual([first.key, second.key]);
      const br = await rectOf(d.frame, sel(button));
      const tr = await rectOf(d.frame, sel(text));
      await clickIn(d.page, d.frame, sel(button), { fx: 0.3, fy: 0.5 });
      // Into the second card, over the lower half of its text: after the text.
      const sx = br.x + br.w * 0.3;
      const sy = br.y + br.h * 0.5;
      let n = await saves(d.page);
      await dragIn(d.page, d.frame, sel(button), tr.x + 40 - sx, tr.y + tr.h * 0.8 - sy, { fx: 0.3, fy: 0.5, steps: 10 });
      await waitSaved(d.page, n);
      button = inserts(d).find((c) => c.id === button.id);
      expect([button.parent, button.index, button.dx || 0, button.dy || 0, button.detached]).toEqual([second.key, 1, 0, 0, undefined]);
      await syncLayer(d.page);
      expect(await d.frame.evaluate((q) => [...document.querySelector(q).children].map((x) => x.getAttribute("data-dftp-el")), sel(second))).toEqual(["text", "button"]);
      expect(await d.frame.evaluate((q) => [...document.querySelector(q).children].map((x) => x.getAttribute("data-dftp-el")), sel(first))).toEqual(["heading"]);
      const md = await fsp.readFile(path.join(d.root, ".dftp", "CHANGES.md"), "utf8");
      expect(md).toContain(`[${button.id}] new button <button> "Button" — inside #3 [${second.id}], item 2 of 2`);
      expect(md).not.toMatch(/detached from its container|render the element outside/);
      n = await saves(d.page);
      await d.page.locator("#undo-btn").click();
      await waitSaved(d.page, n);
      button = inserts(d).find((c) => c.id === button.id);
      expect([button.parent, button.index]).toEqual([first.key, 1]);
      expect(await d.frame.evaluate((q) => [...document.querySelector(q).children].map((x) => x.getAttribute("data-dftp-el")), sel(first))).toEqual(["heading", "button"]);
    } finally {
      await d.close();
    }
  });

  test("a size filled in from another records its own box on the first resize", async ({ browser }) => {
    const d = await open(browser);
    try {
      await clickPalette(d, "button");
      await setDevice(d.page, "phone");
      await expect.poll(() => d.frame.evaluate(() => document.querySelectorAll("[data-dftp-ins]").length)).toBe(1);
      const [button] = inserts(d);
      await clickIn(d.page, d.frame, sel(button), { fx: 0.5, fy: 0.5 });
      const r = await rectOf(d.frame, sel(button));
      const g = await geometry(d.page);
      const grip = toWindow(g, r.x + r.w, r.y + r.h / 2);
      const n = await saves(d.page);
      await d.page.mouse.move(grip.x, grip.y);
      await d.page.mouse.down();
      await d.page.mouse.move(grip.x + 60 * g.k, grip.y, { steps: 5 });
      await d.page.mouse.up();
      await waitSaved(d.page, n);
      const phone = inserts(d, "phone")[0];
      expect(phone.base).toBeTruthy();
      expect(Math.abs(phone.base.w - Math.round(r.w))).toBeLessThanOrEqual(1);
      const md = await fsp.readFile(path.join(d.root, ".dftp", "CHANGES.md"), "utf8");
      expect(md).toMatch(new RegExp(`width from ${phone.base.w} to ${Math.round(phone.w)} px`));
      expect(md).not.toContain("width from ?");
    } finally {
      await d.close();
    }
  });

  test("in dark mode a button label keeps a readable color when the primary color turns light", async ({ browser }) => {
    const d = await open(browser, { files: { "src/app.css": ":root{--primary:#18181b;--background:#ffffff;--foreground:#09090b} .dark{--primary:#fafafa;--background:#09090b;--foreground:#fafafa} body{background:var(--background);color:var(--foreground)}" } });
    try {
      await clickPalette(d, "button");
      const [button] = inserts(d);
      const colors = () => d.frame.evaluate((q) => {
        const cs = getComputedStyle(document.querySelector(q));
        return [cs.backgroundColor, cs.color];
      }, sel(button));
      expect(await colors()).toEqual(["rgb(24, 24, 27)", "rgb(255, 255, 255)"]);
      await d.page.locator("[data-set-theme=\"dark\"]").click();
      await expect.poll(colors).toEqual(["rgb(250, 250, 250)", "rgb(17, 17, 17)"]);
    } finally {
      await d.close();
    }
  });

  test("an image placeholder shows on a page drawn in the surface color, in light and in dark", async ({ browser }) => {
    // The page's body uses the surface color and no token names a muted fill.
    const d = await open(browser, { fixture: path.join(PROJECTS, "css-vars-dark") });
    try {
      await clickPalette(d, "image");
      await d.page.keyboard.press("Escape");
      const [image] = inserts(d);
      // How far the placeholder, laid over the page, is from the page color
      // (largest channel difference, 0-255).
      const gap = () => d.frame.evaluate((q) => {
        const el = document.querySelector(q);
        const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
        const page = getComputedStyle(document.body).backgroundColor;
        ctx.fillStyle = page;
        ctx.fillRect(0, 0, 1, 1);
        const a = [...ctx.getImageData(0, 0, 1, 1).data];
        ctx.fillStyle = getComputedStyle(el).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        const b = [...ctx.getImageData(0, 0, 1, 1).data];
        return Math.max(...[0, 1, 2].map((i) => Math.abs(a[i] - b[i])));
      }, sel(image));
      expect(image.styles.background).toBeUndefined();
      expect(await gap()).toBeGreaterThanOrEqual(10);
      await d.page.locator("[data-set-theme=\"dark\"]").click();
      await expect.poll(() => d.frame.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(255, 255, 255)");
      expect(await gap()).toBeGreaterThanOrEqual(10);
    } finally {
      await d.close();
    }
  });

  test("--blank opens on the blank page when the config file names a dev server that is not running", async ({ browser }) => {
    const d = await open(browser, {
      files: {
        "dftp.config.json": JSON.stringify({ target: "http://127.0.0.1:9", pages: [{ id: "home", label: "Home", path: "/" }] }),
        "src/app.css": ":root{--primary:#2563eb}",
      },
    });
    try {
      await expect(d.page.locator("#page-select option")).toHaveText(["Home", "Blank page"]);
      await expect(d.page.locator("#page-select")).toHaveValue("blank");
      await expect(d.page.locator("#palette-bar")).toBeVisible();
      await expect.poll(() => d.frame.evaluate(() => !!document.querySelector("main[data-dftp-scaffold]"))).toBe(true);
    } finally {
      await d.close();
    }
  });
});
