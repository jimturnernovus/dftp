// Before / After. Before removes all recorded edits from view and blocks
// editing and storing; After draws each edit again at its exact position.

import { test } from "@playwright/test";
import fs from "node:fs";
import {
  openDesigner, expect, clickIn, dragIn, dragFrom, geometry, rectOf, toWindow, saves, waitSaved, waitLoaded,
  wordRect, waitEditor, postToLayer, listIds, docPath, setDevice, setMode,
} from "./helpers.mjs";

const EDGE = { fx: 0.3, fy: 0.12 };
const PAD = { fx: 0.5, fy: 0.07 };

function same(a, b, label) {
  for (const k of ["x", "y", "w", "h"]) {
    expect(Math.abs(a[k] - b[k]), `${label}: ${k} ${a[k]} vs ${b[k]}`).toBeLessThanOrEqual(0.5);
  }
}

async function view(d) {
  return d.page.locator("body").getAttribute("data-current-view");
}

// A move, a resize, a hidden element, a text edit and a moved word.
async function makeChanges(d) {
  let n = await saves(d.page);
  await clickIn(d.page, d.frame, "h1");
  await dragIn(d.page, d.frame, "h1", 40, 16);
  await waitSaved(d.page, n);

  await clickIn(d.page, d.frame, ".kpi:nth-child(2)", PAD);
  const r = await rectOf(d.frame, ".kpi:nth-child(2)");
  n = await saves(d.page);
  await dragFrom(d.page, await geometry(d.page), r.x + r.w, r.y + r.h / 2, 30, 0);
  await waitSaved(d.page, n);

  await clickIn(d.page, d.frame, "#export-btn", EDGE);
  n = await saves(d.page);
  await d.page.keyboard.press("Delete");
  await waitSaved(d.page, n);

  await clickIn(d.page, d.frame, "#new-btn", EDGE);
  await d.page.keyboard.press("e");
  await waitEditor(() => d.frame);
  n = await saves(d.page);
  await d.page.keyboard.type("Add a client");
  await d.page.keyboard.press("Enter");
  await waitSaved(d.page, n);

  const w = await wordRect(d.frame, ".subtitle", "number");
  const g = await geometry(d.page);
  const p = toWindow(g, w.x + w.w / 2, w.y + w.h / 2);
  await d.page.mouse.dblclick(p.x, p.y);
  n = await saves(d.page);
  await dragFrom(d.page, g, w.x + w.w / 2, w.y + w.h / 2, 0, 24);
  await waitSaved(d.page, n);
  expect((await listIds(d.page)).length).toBe(5);
}

const TRACKED = ["h1", ".kpi:nth-child(2)", "#new-btn", ".subtitle [data-dftp-piece]:nth-child(6)"];

async function rects(d) {
  const out = {};
  for (const s of TRACKED) out[s] = await rectOf(d.frame, s);
  return out;
}

test("Before removes all edits from view; After restores each one to within 0.5 px", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    const h1Before = await rectOf(d.frame, "h1");
    const kpiBefore = await rectOf(d.frame, ".kpi:nth-child(2)");
    await makeChanges(d);
    const after = await rects(d);
    await d.page.locator("[data-set-view=\"before\"]").click();
    await expect.poll(() => view(d)).toBe("before");
    await expect(d.page.locator("#before-note")).toBeVisible();
    await expect(d.page.locator("#before-note")).toContainText("Before view: the page without your 5 edits. Editing and storing are paused; key B or the After button brings them back.");
    await expect(d.page.locator("#undo-btn")).toBeDisabled();
    await expect(d.page.locator("#redo-btn")).toBeDisabled();
    await expect(d.page.locator("#clear-page")).toBeDisabled();
    await expect(d.page.locator("#change-list")).toHaveClass(/faded/);
    await expect(d.page.locator("body")).toHaveAttribute("data-current-mode", "use");
    await expect.poll(async () => {
      const r = await rectOf(d.frame, "h1");
      return ["x", "y", "w", "h"].every((k) => Math.abs(r[k] - h1Before[k]) <= 0.5);
    }).toBe(true);
    same(await rectOf(d.frame, ".kpi:nth-child(2)"), kpiBefore, "tile in Before");
    expect(await d.frame.evaluate(() => getComputedStyle(document.querySelector("#export-btn")).display)).not.toBe("none");
    expect(await d.frame.evaluate(() => document.querySelector("#new-btn").textContent.trim())).toBe("New client");
    expect(await d.frame.evaluate(() => document.querySelectorAll("[data-dftp]").length)).toBe(0);
    expect(await d.frame.evaluate(() => document.documentElement.classList.contains("dftp-design"))).toBe(false);

    await d.page.locator("[data-set-view=\"after\"]").click();
    await expect.poll(() => view(d)).toBe("after");
    await expect(d.page.locator("#before-note")).toBeHidden();
    await expect(d.page.locator("body")).toHaveAttribute("data-current-mode", "design");
    // The layer gets the switch as a message: wait for it, then compare all.
    // Every tracked element (the split word included) may land a moment after
    // the heading on a slow machine, so wait until all of them are back.
    for (const s of TRACKED) expect(after[s], `${s} measured after the edits`).not.toBeNull();
    const close = (a, b) => !!a && !!b && ["x", "y", "w", "h"].every((k) => Math.abs(a[k] - b[k]) <= 0.5);
    await expect.poll(async () => {
      const now = await rects(d);
      return TRACKED.filter((s) => !close(now[s], after[s]));
    }, { timeout: 10000 }).toEqual([]);
    const back = await rects(d);
    for (const s of TRACKED) same(back[s], after[s], s);
    expect(await d.frame.evaluate(() => getComputedStyle(document.querySelector("#export-btn")).display)).toBe("none");
    expect(await d.frame.evaluate(() => document.querySelector("#new-btn").textContent.trim())).toBe("Add a client");
  } finally {
    await d.close();
  }
});

test("while Before shows nothing is edited or saved: no POST, file untouched", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    await makeChanges(d);
    const ids = await listIds(d.page);
    const key = await d.page.locator("#change-list li").first().getAttribute("data-key");
    const file = docPath(d.root);
    const mtime = fs.statSync(file).mtimeMs;
    const h1Orig = await d.frame.evaluate(() => getComputedStyle(document.querySelector("h1")).translate);
    expect(h1Orig).not.toBe("none");

    await d.page.locator("[data-set-view=\"before\"]").click();
    await expect.poll(() => view(d)).toBe("before");
    const postsBefore = d.posts.length;

    // Edit messages straight to the layer, as a forged or stale shell would send.
    await postToLayer(d.page, d.app.frameOrigin, [
      { type: "key", init: { key: "Delete" } },
      { type: "key", init: { key: "ArrowLeft", shift: true } },
      { type: "key", init: { key: "z", meta: true } },
      { type: "reset", key: null },
      { type: "reset", key },
      { type: "undo" },
      { type: "redo" },
      { type: "edit" },
      { type: "show", key },
      { type: "select", key },
      { type: "reattach", key },
      { type: "mode", mode: "design" },
    ]);
    // Keys in the designer window.
    await d.page.locator(".ident").click();
    for (const k of ["Delete", "ArrowRight", "Shift+ArrowDown", "e", "r", "p", "Meta+z", "Escape", "Backspace"]) await d.page.keyboard.press(k);
    // Keys and clicks in the page itself.
    await clickIn(d.page, d.frame, ".kpi:nth-child(1)", PAD);
    for (const k of ["Delete", "ArrowLeft", "ArrowUp", "e", "E", "r", "Meta+z", "Enter", "d", "g"]) await d.page.keyboard.press(k);
    await d.page.locator("#undo-btn").click({ force: true });
    await d.page.locator("#clear-page").click({ force: true });
    await d.page.waitForTimeout(900);

    expect(d.posts.length - postsBefore, d.posts.slice(postsBefore).map((p) => p.url).join(", ")).toBe(0);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(await view(d)).toBe("before");
    expect(await d.frame.evaluate(() => getComputedStyle(document.querySelector("h1")).translate)).toBe("none");
    expect(await d.frame.evaluate(() => document.querySelectorAll("[data-dftp]").length)).toBe(0);
    expect(await listIds(d.page)).toEqual(ids);

    await d.page.locator("#before-exit").click();
    await expect.poll(() => view(d)).toBe("after");
    await expect.poll(() => d.frame.evaluate(() => getComputedStyle(document.querySelector("h1")).translate)).toBe(h1Orig);
    expect(await listIds(d.page)).toEqual(ids);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  } finally {
    await d.close();
  }
});

test("B toggles Before / After from the designer window and from inside the page", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    await clickIn(d.page, d.frame, "h1");
    const n = await saves(d.page);
    await dragIn(d.page, d.frame, "h1", 30, 0);
    await waitSaved(d.page, n);

    await d.page.locator(".ident").click();
    await d.page.keyboard.press("b");
    await expect.poll(() => view(d)).toBe("before");
    await d.page.keyboard.press("B");
    await expect.poll(() => view(d)).toBe("after");

    // From the page: in Use mode a click gives the page the focus.
    await setMode(d.page, "use");
    // Record which messages come from the page, to be sure the key went there.
    await d.page.evaluate(() => {
      window.seenFromFrame = [];
      window.addEventListener("message", (e) => {
        if (e.data && typeof e.data.type === "string") window.seenFromFrame.push(e.data.type);
      });
    });
    await clickIn(d.page, d.frame, ".subtitle");
    await d.page.keyboard.press("b");
    await expect.poll(() => d.page.evaluate(() => window.seenFromFrame.includes("view-toggle"))).toBe(true);
    await expect.poll(() => view(d)).toBe("before");
    await expect.poll(() => d.frame.evaluate(() => getComputedStyle(document.querySelector("h1")).translate)).toBe("none");
    await d.page.keyboard.press("b");
    await expect.poll(() => view(d)).toBe("after");
    await expect.poll(() => d.frame.evaluate(() => getComputedStyle(document.querySelector("h1")).translate)).not.toBe("none");
    await expect(d.page.locator("body")).toHaveAttribute("data-current-mode", "use");

    // Typing a "b" into the page's own search box is just typing.
    await clickIn(d.page, d.frame, "#search");
    await d.page.keyboard.type("bb");
    expect(await d.frame.evaluate(() => document.querySelector("#search").value)).toBe("bb");
    expect(await view(d)).toBe("after");
  } finally {
    await d.close();
  }
});

test("switching device returns to After", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    await clickIn(d.page, d.frame, "h1");
    const n = await saves(d.page);
    await dragIn(d.page, d.frame, "h1", 30, 0);
    await waitSaved(d.page, n);
    await d.page.locator("[data-set-view=\"before\"]").click();
    await expect.poll(() => view(d)).toBe("before");
    await setDevice(d.page, "tablet");
    expect(await view(d)).toBe("after");
    await expect(d.page.locator("#before-note")).toBeHidden();
    await expect(d.page.locator("body")).toHaveAttribute("data-current-mode", "design");
    await setDevice(d.page, "desktop");
    expect(await view(d)).toBe("after");
    await expect.poll(() => d.frame.evaluate(() => getComputedStyle(document.querySelector("h1")).translate)).not.toBe("none");
  } finally {
    await d.close();
  }
});

test("a page that reloads itself during Before stays in Before", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    const orig = await rectOf(d.frame, "h1");
    await clickIn(d.page, d.frame, "h1");
    const n = await saves(d.page);
    await dragIn(d.page, d.frame, "h1", 30, 10);
    await waitSaved(d.page, n);
    const moved = await rectOf(d.frame, "h1");
    await d.page.locator("[data-set-view=\"before\"]").click();
    await expect.poll(() => view(d)).toBe("before");
    const postsBefore = d.posts.length;

    const old = d.frame;
    await old.evaluate(() => location.reload());
    await expect.poll(() => d.page.frames().find((f) => f.parentFrame() === d.page.mainFrame()) !== old).toBe(true);
    await waitLoaded(d.page);
    expect(await view(d)).toBe("before");
    await expect(d.page.locator("#before-note")).toBeVisible();
    same(await rectOf(d.frame, "h1"), orig, "h1 after the reload, in Before");
    expect(await d.frame.evaluate(() => document.querySelectorAll("[data-dftp]").length)).toBe(0);
    await d.page.waitForTimeout(1200);
    same(await rectOf(d.frame, "h1"), orig, "h1 once the page settled, in Before");
    expect(d.posts.length).toBe(postsBefore);

    await d.page.locator("[data-set-view=\"after\"]").click();
    await expect.poll(() => view(d)).toBe("after");
    await expect.poll(async () => (await rectOf(d.frame, "h1")).x).toBeCloseTo(moved.x, 0);
  } finally {
    await d.close();
  }
});
