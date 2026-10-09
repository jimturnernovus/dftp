// Blank pages (--blank): the scaffold on every built-in device, the element
// palette (drag and click), editing a new element with the usual tools,
// reload, Before / After, undo / redo, the "New elements" section of
// CHANGES.md, the project's components, and a screen size that starts with
// another size's new elements. The project is a copy of the Tailwind CSS v4
// fixture, which has src/components/ui/button.jsx and card.jsx.

import { test } from "@playwright/test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  openDesigner, expect, tempRoot, removeRoot, TOOL_DIR, geometry, toWindow, rectOf, clickIn, dragIn, saves, waitSaved,
  readDoc, waitLoaded, setDevice, syncLayer, waitEditor, translateOf, postToLayer,
} from "./helpers.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

const LONG_TEST_MS = 90000;
const FIXTURE = path.join(TOOL_DIR, "test", "fixtures", "projects", "tailwind-v4");
const KINDS = ["heading", "text", "button", "input", "card", "image", "divider", "section", "grid"];

async function blankProject() {
  const root = await tempRoot({ demo: false });
  await fsp.cp(FIXTURE, root, { recursive: true });
  return root;
}

async function openBlank(browser, opts = {}) {
  const root = await blankProject();
  const d = await openDesigner(browser, { root, flags: { demo: false, blank: [null] }, prefs: opts.prefs, keepRoot: false });
  d.ownRoot = root;
  const close = d.close;
  d.close = async () => {
    await close();
    await fsp.rm(root, { recursive: true, force: true });
  };
  return d;
}

const doc = (d, device = "desktop") => readDoc(d.root, "blank", device);
const inserts = (d, device) => {
  const x = doc(d, device);
  return x ? x.list.filter((c) => c.kind === "insert") : [];
};
const kindsOnPage = (frame) => frame.evaluate(() => [...document.querySelectorAll("[data-dftp-ins]")].map((el) => el.getAttribute("data-dftp-el")));

// Drag a palette item and drop it at a point of the frame (frame pixels).
async function dropAt(d, kind, x, y) {
  const n = await saves(d.page);
  const b = await d.page.locator(`[data-insert="${kind}"]`).boundingBox();
  const g = await geometry(d.page);
  const to = toWindow(g, x, y);
  await d.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await d.page.mouse.down();
  for (let i = 1; i <= 6; i++) await d.page.mouse.move(b.x + (to.x - b.x) * (i / 6), b.y + (to.y - b.y) * (i / 6));
  await d.page.mouse.up();
  await waitSaved(d.page, n);
}

// Drop below everything already on the page (scrolled to its end).
async function dropAtEnd(d, kind) {
  const p = await d.frame.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const sc = document.querySelector("main[data-dftp-scaffold]").getBoundingClientRect();
    const k = [...document.querySelectorAll("main[data-dftp-scaffold] > [data-dftp-ins]")].pop();
    const below = k ? k.getBoundingClientRect().bottom + 12 : sc.top + 40;
    return { x: sc.left + sc.width / 2, y: Math.min(below, window.innerHeight - 6) };
  });
  await dropAt(d, kind, p.x, p.y);
}

async function clickPalette(d, kind) {
  const n = await saves(d.page);
  await d.page.locator(`[data-insert="${kind}"]`).click();
  await waitSaved(d.page, n);
}

const sel = (c) => `[data-dftp-ins="${c.id}"]`;
const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

function tokenHex(root, id) {
  const t = JSON.parse(fs.readFileSync(path.join(root, ".dftp", "tokens.json"), "utf8")).tokens.find((x) => x.id === id);
  return t.value.hex;
}

test.describe("blank pages", () => {
  test.setTimeout(LONG_TEST_MS);

  test("the scaffold renders on desktop, tablet and phone, styled from the project's tokens", async ({ browser }) => {
    const d = await openBlank(browser);
    try {
      await expect(d.page.locator("#palette-bar")).toBeVisible();
      await expect(d.page.locator("#palette-bar [data-insert]")).toHaveCount(KINDS.length);
      const shape = () => d.frame.evaluate(() => {
        const cs = getComputedStyle(document.querySelector("main[data-dftp-scaffold]"));
        return { display: cs.display, cols: cs.gridTemplateColumns.split(" ").length, dir: cs.flexDirection, font: getComputedStyle(document.body).fontFamily };
      });
      let s = await shape();
      expect(s.display).toBe("grid");
      expect(s.cols).toBe(12);
      expect(s.font).toContain("Inter");
      // Light / Dark: the blank page has a switch of its own and the tokens' dark values.
      const bg = () => d.frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(await bg()).toBe("rgb(255, 255, 255)");
      await d.page.locator("[data-set-theme=\"dark\"]").click();
      await expect.poll(bg).toBe("rgb(10, 10, 10)");
      await d.page.locator("[data-set-theme=\"light\"]").click();
      await expect.poll(bg).toBe("rgb(255, 255, 255)");
      await setDevice(d.page, "tablet");
      s = await shape();
      expect(s.display).toBe("grid");
      expect(s.cols).toBe(6);
      await setDevice(d.page, "phone");
      s = await shape();
      expect(s.display).toBe("flex");
      expect(s.dir).toBe("column");
      // Nothing of the project runs here: the document is the generated one.
      expect(await d.frame.evaluate(() => document.querySelectorAll("script:not([src*='/__dftp/'])").length)).toBe(0);
    } finally {
      await d.close();
    }
  });

  test("every palette element drags in pre-styled, is saved as an insert and names the project's component", async ({ browser }) => {
    const d = await openBlank(browser);
    try {
      for (const k of KINDS) await dropAtEnd(d, k);
      expect(await kindsOnPage(d.frame)).toEqual(KINDS);
      const list = inserts(d);
      expect(list.map((c) => c.element)).toEqual(KINDS);
      expect(list.every((c) => c.parent === "scaffold" && c.key === `ins:${c.id}`)).toBe(true);
      expect(list.map((c) => c.index)).toEqual(KINDS.map((_, i) => i));
      const by = (k) => list.find((c) => c.element === k);
      expect(by("button").component).toBe("Button");
      expect(by("button").component_file).toBe("src/components/ui/button.jsx");
      expect(by("card").component).toBe("Card");
      expect(by("heading").component).toBeUndefined();
      expect(by("button").styles.background).toBe("color.primary");
      expect(by("button").styles.color).toBe("color.primary.foreground");
      expect(by("heading").styles.color).toBe("color.foreground");
      // What the page shows comes from those tokens.
      const css = (s, prop) => d.frame.evaluate(([q, p]) => getComputedStyle(document.querySelector(q)).getPropertyValue(p), [s, prop]);
      expect(await css(sel(by("button")), "background-color")).toBe(rgb(tokenHex(d.root, "color.primary")));
      expect(await css(sel(by("button")), "color")).toBe(rgb(tokenHex(d.root, "color.primary.foreground")));
      expect(await css(sel(by("heading")), "color")).toBe(rgb(tokenHex(d.root, "color.foreground")));
      expect(await d.frame.evaluate((q) => document.querySelector(q).getAttribute("data-dftp-component"), sel(by("button")))).toBe("Button");
      // The panel lists them as new elements.
      await expect(d.page.locator("#change-list li")).toHaveCount(KINDS.length);
      await expect(d.page.locator("#change-list")).toContainText("new button");
    } finally {
      await d.close();
    }
  });

  test("click adds to the selected box, a drop on a box nests, and the main container stays fixed", async ({ browser }) => {
    const d = await openBlank(browser);
    try {
      await clickPalette(d, "card");
      let [card] = inserts(d);
      expect(card.parent).toBe("scaffold");
      // The new card is selected: the next click goes into it.
      await expect(d.page.locator("#palette-bar")).toContainText("into the selected card");
      await clickPalette(d, "button");
      const r = await rectOf(d.frame, sel(card));
      await dropAt(d, "text", r.x + r.w / 2, r.y + r.h - 6);
      const list = inserts(d);
      card = list.find((c) => c.element === "card");
      const inCard = list.filter((c) => c.parent === card.key).sort((a, b) => a.index - b.index).map((c) => c.element);
      expect(inCard).toEqual(["button", "text"]);
      expect(await d.frame.evaluate((q) => [...document.querySelector(q).children].map((x) => x.getAttribute("data-dftp-el")), sel(card))).toEqual(["button", "text"]);
      // Another card, clicked while the card is selected, goes after it.
      await clickIn(d.page, d.frame, sel(card), { fx: 0.5, fy: 0.04 });
      await expect(d.page.locator("#picked")).toContainText("a new element");
      await clickPalette(d, "card");
      const second = inserts(d).filter((c) => c.element === "card").find((c) => c.id !== card.id);
      expect([second.parent, second.index]).toEqual(["scaffold", 1]);
      // The scaffold can be picked but not hidden.
      const box = await rectOf(d.frame, "main[data-dftp-scaffold]");
      const g = await geometry(d.page);
      const p = toWindow(g, box.x + 6, box.y + 6);
      await d.page.mouse.click(p.x, p.y);
      await expect(d.page.locator("#picked")).toContainText("main container of this blank page");
      await d.page.keyboard.press("Delete");
      await expect(d.page.locator("#notices")).toContainText("main container of a blank page stays");
      await syncLayer(d.page);
      expect(inserts(d)).toHaveLength(4);
      expect(doc(d).list).toHaveLength(4);
    } finally {
      await d.close();
    }
  });

  test("a new element moves, resizes, hides and takes new text; a reload draws it again", async ({ browser }) => {
    const d = await openBlank(browser);
    try {
      await clickPalette(d, "heading");
      await clickPalette(d, "button");
      let [heading, button] = inserts(d);
      expect(heading.element).toBe("heading");
      // Move.
      await clickIn(d.page, d.frame, sel(button), { fx: 0.2, fy: 0.2 });
      let n = await saves(d.page);
      await dragIn(d.page, d.frame, sel(button), 40, 24, { fx: 0.2, fy: 0.2 });
      await waitSaved(d.page, n);
      button = inserts(d).find((c) => c.id === button.id);
      expect(Math.abs(button.dx - 40)).toBeLessThanOrEqual(3);
      expect(Math.abs(button.dy - 24)).toBeLessThanOrEqual(3);
      // Resize with the east grip.
      const r = await rectOf(d.frame, sel(button));
      const g = await geometry(d.page);
      const grip = toWindow(g, r.x + r.w, r.y + r.h / 2);
      n = await saves(d.page);
      await d.page.mouse.move(grip.x, grip.y);
      await d.page.mouse.down();
      await d.page.mouse.move(grip.x + 30 * g.k, grip.y, { steps: 4 });
      await d.page.mouse.up();
      await waitSaved(d.page, n);
      button = inserts(d).find((c) => c.id === button.id);
      expect(Math.abs(button.w - (Math.round(r.w) + 30))).toBeLessThanOrEqual(3);
      // New text.
      await clickIn(d.page, d.frame, sel(button), { fx: 0.5, fy: 0.5 });
      await d.page.keyboard.press("e");
      await waitEditor(() => d.frame);
      n = await saves(d.page);
      await d.page.keyboard.press("ControlOrMeta+a");
      await d.page.keyboard.type("Buy now");
      await d.page.keyboard.press("Enter");
      await waitSaved(d.page, n);
      button = inserts(d).find((c) => c.id === button.id);
      expect(button.text_to).toBe("Buy now");
      expect(await d.frame.locator(sel(button)).textContent()).toBe("Buy now");
      // Hide.
      await clickIn(d.page, d.frame, sel(heading), { fx: 0.1, fy: 0.5 });
      n = await saves(d.page);
      await d.page.keyboard.press("Delete");
      await waitSaved(d.page, n);
      heading = inserts(d).find((c) => c.id === heading.id);
      expect(heading.hidden).toBe(true);
      const moved = await translateOf(d.frame, sel(button));
      // Reload: the same elements, with their edits.
      await d.page.locator("#reload-page").click();
      await waitLoaded(d.page);
      await expect.poll(() => kindsOnPage(d.frame)).toEqual(["heading", "button"]);
      await expect.poll(() => translateOf(d.frame, sel(button))).toBe(moved);
      expect(await d.frame.locator(sel(button)).textContent()).toBe("Buy now");
      expect(await d.frame.evaluate((q) => getComputedStyle(document.querySelector(q)).display, sel(heading))).toBe("none");
      expect(inserts(d).map((c) => c.id)).toEqual([heading.id, button.id]);
    } finally {
      await d.close();
    }
  });

  test("Before hides new elements and After brings them back; undo and redo", async ({ browser }) => {
    const d = await openBlank(browser);
    try {
      await clickPalette(d, "heading");
      await clickPalette(d, "text");
      expect(await kindsOnPage(d.frame)).toEqual(["heading", "text"]);
      await d.page.locator("[data-set-view=\"before\"]").click();
      await expect.poll(() => kindsOnPage(d.frame)).toEqual([]);
      await expect(d.page.locator("#palette-bar [data-insert=\"text\"]")).toBeDisabled();
      await d.page.locator("[data-set-view=\"after\"]").click();
      await expect.poll(() => kindsOnPage(d.frame)).toEqual(["heading", "text"]);
      let n = await saves(d.page);
      await d.page.locator("#undo-btn").click();
      await waitSaved(d.page, n);
      expect(await kindsOnPage(d.frame)).toEqual(["heading"]);
      expect(inserts(d).map((c) => c.element)).toEqual(["heading"]);
      n = await saves(d.page);
      await d.page.locator("#redo-btn").click();
      await waitSaved(d.page, n);
      expect(await kindsOnPage(d.frame)).toEqual(["heading", "text"]);
      expect(inserts(d).map((c) => c.element)).toEqual(["heading", "text"]);
      // Reset removes a box together with what it holds.
      await clickPalette(d, "section");
      await clickPalette(d, "button");
      const section = inserts(d).find((c) => c.element === "section");
      expect(inserts(d).find((c) => c.element === "button").parent).toBe(section.key);
      n = await saves(d.page);
      await d.page.locator(`#change-list li[data-id="${section.id}"] button`, { hasText: "Reset" }).click();
      await waitSaved(d.page, n);
      expect(inserts(d).map((c) => c.element)).toEqual(["heading", "text"]);
      expect(await kindsOnPage(d.frame)).toEqual(["heading", "text"]);
    } finally {
      await d.close();
    }
  });

  test("CHANGES.md has a New elements section with components and token styles", async ({ browser }) => {
    const d = await openBlank(browser);
    try {
      await clickPalette(d, "card");
      await clickPalette(d, "button");
      const [card, button] = inserts(d);
      const md = fs.readFileSync(path.join(d.root, ".dftp", "CHANGES.md"), "utf8");
      expect(md).toContain("## Page \"blank\"");
      expect(md).toContain("This page is new");
      expect(md).toContain("### New elements");
      expect(md).toContain(`1. [${card.id}] new card <div> — inside the page's main container, item 1 of 1`);
      expect(md).toContain(`2. [${button.id}] new button <button> "Button" — inside #1 [${card.id}], item 1 of 1`);
      expect(md).toContain("use the project's component Button from src/components/ui/button.jsx");
      expect(md).toContain("use the project's component Card from src/components/ui/card.jsx");
      expect(md).toMatch(/background = color\.primary \("--primary" in src\/index\.css:\d+, "--color-primary" in src\/index\.css:\d+\)/);
    } finally {
      await d.close();
    }
  });

  test("a screen size with nothing stored starts with the new elements of another", async ({ browser }) => {
    const d = await openBlank(browser);
    try {
      await clickPalette(d, "heading");
      await clickPalette(d, "button");
      const desk = inserts(d);
      await setDevice(d.page, "phone");
      await expect.poll(() => kindsOnPage(d.frame)).toEqual(["heading", "button"]);
      expect(doc(d, "phone")).toBeNull();
      // The first edit on the phone stores them there, with the same ids.
      const n = await saves(d.page);
      await clickPalette(d, "text");
      await waitSaved(d.page, n);
      const phone = inserts(d, "phone");
      expect(phone.map((c) => c.id).slice(0, 2)).toEqual(desk.map((c) => c.id));
      expect(phone.map((c) => c.element)).toEqual(["heading", "button", "text"]);
      const md = fs.readFileSync(path.join(d.root, ".dftp", "CHANGES.md"), "utf8");
      // The tablet was never opened: it shows the desktop's elements too.
      expect(md).toContain(`- ${desk[0].id} — page "blank": same change on desktop, tablet, phone`);
      expect(md).toContain("- page \"blank\" — tablet: not edited; it shows the desktop layout");
    } finally {
      await d.close();
    }
  });

  test("next to a proxied app: the palette belongs to the blank page, and the app's page takes no new elements", async ({ browser }) => {
    const up = await startUpstream();
    const root = await tempRoot({ demo: false });
    const d = await openDesigner(browser, { root, flags: { demo: false, target: up.origin, pages: ["/spa"], blank: [null] } });
    try {
      await expect(d.page.locator("#page-select option")).toHaveText(["/spa", "Blank page"]);
      // --blank opens on the blank page; the app's page is listed first.
      await expect(d.page.locator("#page-select")).toHaveValue("blank");
      await expect(d.page.locator("#palette-bar")).toBeVisible();
      await d.page.locator("#page-select").selectOption("spa");
      await waitLoaded(d.page);
      await expect(d.page.locator("#palette-bar")).toBeHidden();
      // A forged insert on the app's page does nothing.
      await postToLayer(d.page, d.app.frameOrigin, [{ type: "insert", element: "button", styles: {} }]);
      await syncLayer(d.page);
      expect(await d.frame.evaluate(() => document.querySelectorAll("[data-dftp-ins]").length)).toBe(0);
      expect(readDoc(root, "spa", "desktop")).toBeNull();
      await d.page.locator("#page-select").selectOption("blank");
      await waitLoaded(d.page);
      await expect(d.page.locator("#palette-bar")).toBeVisible();
      await clickPalette(d, "button");
      expect(inserts(d).map((c) => c.element)).toEqual(["button"]);
      await d.page.locator("#page-select").selectOption("spa");
      await waitLoaded(d.page);
      await expect(d.page.locator("#palette-bar")).toBeHidden();
    } finally {
      await d.close();
      await up.close();
      await removeRoot(root);
    }
  });
});
