// Scrolling a page whose content scrolls inside an app shell, the
// always-visible scroll rail, and elements dragged out of their parent box.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  openDesigner, rootWith, removeRoot, FIXTURES, expect, clickIn, dragIn, geometry, rectOf, toWindow, readDoc, saves, waitSaved, setMode, syncLayer,
} from "./helpers.mjs";

const PAGE = "scroll-shell.html";

// The fixture page, with its stylesheet in place of the demo one (the demo
// server only serves its own file names).
async function open(browser) {
  const root = await rootWith(PAGE);
  await fsp.copyFile(path.join(FIXTURES, "scroll-shell.css"), path.join(root, "demo", "demo.css"));
  const d = await openDesigner(browser, { root });
  const close = d.close;
  d.close = async () => {
    await close();
    await removeRoot(root);
  };
  return d;
}

async function settle(d) {
  const n = await saves(d.page);
  await waitSaved(d.page, n);
}
const scrollTop = (d) => d.frame.evaluate(() => document.getElementById("scroller").scrollTop);

async function wheelOver(d, fx, fy, times = 4) {
  const g = await geometry(d.page);
  const p = toWindow(g, fx, fy);
  await d.page.mouse.move(p.x, p.y);
  for (let i = 0; i < times; i++) await d.page.mouse.wheel(0, 200);
  await syncLayer(d.page);
}

test("the wheel scrolls a shell page's own scroller in both modes, also once an element was moved", async ({ browser }) => {
  const d = await open(browser);
  try {
    await clickIn(d.page, d.frame, "#second");
    await d.page.keyboard.press("ArrowDown");
    await settle(d);
    // The boxes around the scroller keep their clipping, so it still scrolls.
    const shell = await d.frame.evaluate(() => [".app", ".body"].map((s) => getComputedStyle(document.querySelector(s)).overflowY));
    expect(shell).toEqual(["hidden", "hidden"]);
    await wheelOver(d, 600, 400);
    await expect.poll(() => scrollTop(d)).toBeGreaterThan(300);
    await d.frame.evaluate(() => { document.getElementById("scroller").scrollTop = 0; });
    await setMode(d.page, "use");
    await wheelOver(d, 600, 400);
    await expect.poll(() => scrollTop(d)).toBeGreaterThan(300);
  } finally {
    await d.close();
  }
});

test("the scroll rail is always shown for the main scroller and drags, pages and wheels it", async ({ browser }) => {
  const d = await open(browser);
  try {
    // The rail lives in the layer's closed shadow root; its place is found
    // from the scroller's box (its right edge, full height).
    const g = await geometry(d.page);
    const sc = await rectOf(d.frame, "#scroller");
    const railX = sc.x + sc.w - 4;
    // A press on the track below the thumb pages down.
    let p = toWindow(g, railX, sc.y + sc.h - 20);
    await d.page.mouse.click(p.x, p.y);
    await expect.poll(() => scrollTop(d)).toBeGreaterThan(200);
    // Dragging the thumb (now just below the top) back up returns to the top.
    const before = await scrollTop(d);
    const thumbY = sc.y + ((sc.h * before) / (await d.frame.evaluate(() => document.getElementById("scroller").scrollHeight))) + 14;
    p = toWindow(g, railX, thumbY);
    await d.page.mouse.move(p.x, p.y);
    await d.page.mouse.down();
    const q = toWindow(g, railX, sc.y - 200);
    await d.page.mouse.move(q.x, q.y, { steps: 5 });
    await d.page.mouse.up();
    await expect.poll(() => scrollTop(d)).toBe(0);
    // The wheel over the rail scrolls the scroller, not the (unscrollable) document.
    await wheelOver(d, railX, sc.y + 200, 2);
    await expect.poll(() => scrollTop(d)).toBeGreaterThan(100);
    // The rail takes no room: the scroller's content width is unchanged.
    expect(await d.frame.evaluate(() => document.getElementById("scroller").clientWidth)).toBe(Math.round(sc.w));
  } finally {
    await d.close();
  }
});

test("an element dropped outside its parent box is detached: the box closes up, it stays put, it rejoins when dropped back", async ({ browser }) => {
  const d = await open(browser);
  try {
    const card0 = await rectOf(d.frame, "#card");
    const el0 = await rectOf(d.frame, "#second");
    // Drag it to well below the card.
    const dy = card0.y + card0.h - el0.y + 40;
    await clickIn(d.page, d.frame, "#second");
    await dragIn(d.page, d.frame, "#second", 30, dy);
    await settle(d);
    let doc = readDoc(d.root);
    expect(doc.list).toHaveLength(1);
    expect(doc.list[0].detached).toBe(true);
    expect(doc.list[0].container.tag).toBe("section");
    const card1 = await rectOf(d.frame, "#card");
    expect(card1.h).toBeLessThan(card0.h - el0.h + 2);
    const el1 = await rectOf(d.frame, "#second");
    expect(el1.x).toBeCloseTo(el0.x + 30, 0);
    expect(el1.y).toBeCloseTo(el0.y + dy, 0);
    expect(el1.w).toBeCloseTo(el0.w, 0);
    // The third line moved up into the space the second one left.
    expect((await rectOf(d.frame, "#third")).y).toBeLessThan(el0.y + 2);
    // CHANGES.md tells the reader to take it out of that container.
    const md = fs.readFileSync(path.join(d.root, ".dftp", "CHANGES.md"), "utf8");
    expect(md).toContain("detached from its container");
    expect(md).toMatch(/container: dragged out of <section>/);
    // It scrolls along with the scroller's content.
    const top0 = (await rectOf(d.frame, "#second")).y;
    await d.frame.evaluate(() => { document.getElementById("scroller").scrollTop = 100; });
    expect((await rectOf(d.frame, "#second")).y).toBeCloseTo(top0 - 100, 0);
    await d.frame.evaluate(() => { document.getElementById("scroller").scrollTop = 0; });
    // Undo puts it back in the card; redo takes it out again.
    let n = await saves(d.page);
    await d.page.locator("#undo-btn").click();
    await waitSaved(d.page, n);
    expect((await rectOf(d.frame, "#card")).h).toBeCloseTo(card0.h, 0);
    n = await saves(d.page);
    await d.page.locator("#redo-btn").click();
    await waitSaved(d.page, n);
    expect(readDoc(d.root).list[0].detached).toBe(true);
    expect((await rectOf(d.frame, "#card")).h).toBeCloseTo(card1.h, 0);
    // Dropped back over the card, it belongs to it again.
    const now = await rectOf(d.frame, "#second");
    const card = await rectOf(d.frame, "#card");
    await dragIn(d.page, d.frame, "#second", card.x + 20 - now.x, card.y + 10 - now.y);
    await settle(d);
    doc = readDoc(d.root);
    expect(doc.list[0].detached).toBeUndefined();
    expect(doc.list[0].container).toBeUndefined();
    expect((await rectOf(d.frame, "#card")).h).toBeCloseTo(card0.h, 0);
    // Before shows the page as built; After brings the change back.
    await d.page.locator("[data-set-view=\"before\"]").click();
    await expect.poll(async () => (await rectOf(d.frame, "#second")).y).toBeCloseTo(el0.y, 0);
  } finally {
    await d.close();
  }
});
