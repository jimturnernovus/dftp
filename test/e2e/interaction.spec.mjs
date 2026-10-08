// Keyboard focus, keys in Use mode, snapping, the text editor, resizing,
// parent picking and changes on repeated rows. Each test starts its own
// servers and a throwaway copy of the demo.

import { test } from "@playwright/test";
import {
  openDesigner, expect, clickIn, dragIn, dragFrom, geometry, rectOf, toWindow, readDoc, saves, waitSaved,
  wordRect, changeFor, translateOf, waitEditor, syncLayer, setMode, waitMode, listIds,
} from "./helpers.mjs";

const PAD = { fx: 0.5, fy: 0.07 };
const nearLine = (v, g) => Math.abs(v - Math.round(v / g) * g);

async function settle(d) {
  const n = await saves(d.page);
  await waitSaved(d.page, n);
}

test("Return after a toolbar click edits the picked element instead of pressing that button again", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    await clickIn(d.page, d.frame, "h1");
    await d.page.keyboard.press("ArrowRight");
    await settle(d);
    await clickIn(d.page, d.frame, ".subtitle");
    await d.page.keyboard.press("Delete");
    await settle(d);
    expect(await listIds(d.page)).toHaveLength(2);
    const n = await saves(d.page);
    await d.page.locator("#undo-btn").click();
    await waitSaved(d.page, n);
    expect(await listIds(d.page)).toHaveLength(1);
    await clickIn(d.page, d.frame, ".kpi:nth-child(1) .kpi-label");
    await d.page.keyboard.press("Enter");
    await waitEditor(() => d.frame, true);
    expect(await listIds(d.page)).toHaveLength(1);
    await d.page.keyboard.press("Escape");
    await waitEditor(() => d.frame, false);
  } finally {
    await d.close();
  }
});

test("after using the grid-size or page list, arrow keys, Delete and B act on the page again", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    const chip = ".chip[data-status=\"active\"]";
    await d.page.locator("#grid-pitch").selectOption("16");
    await clickIn(d.page, d.frame, chip);
    const r0 = await rectOf(d.frame, chip);
    await d.page.keyboard.press("ArrowRight");
    await settle(d);
    expect((await rectOf(d.frame, chip)).x - r0.x).toBeCloseTo(1, 0);
    await d.page.locator("#page-select").focus();
    await clickIn(d.page, d.frame, ".chip[data-status=\"trial\"]");
    await d.page.keyboard.press("Delete");
    await settle(d);
    expect(await d.frame.evaluate(() => getComputedStyle(document.querySelector(".chip[data-status=\"trial\"]")).display)).toBe("none");
    await d.page.keyboard.press("b");
    await expect(d.page.locator("#before-note")).toBeVisible();
    await d.page.keyboard.press("b");
    await expect(d.page.locator("#before-note")).toBeHidden();
  } finally {
    await d.close();
  }
});

test("D, G and Cmd/Ctrl+S work in Use mode while the page has the focus, but not while typing in it", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    await setMode(d.page, "use");
    await d.frame.locator(".chip[data-status=\"paused\"]").click();
    await d.page.keyboard.press("g");
    await expect(d.page.locator("#grid-toggle")).toHaveClass(/is-on/);
    await d.page.keyboard.press("g");
    await expect(d.page.locator("#grid-toggle")).not.toHaveClass(/is-on/);
    await d.page.keyboard.press("ControlOrMeta+s");
    await expect(d.page.locator(".notice").last()).toContainText("Stored.");
    // Typing into the page's own search box goes to the page.
    await d.frame.locator("#search").click();
    await d.page.keyboard.type("dg");
    expect(await d.frame.locator("#search").inputValue()).toBe("dg");
    await expect(d.page.locator("body")).toHaveAttribute("data-current-mode", "use");
    await d.frame.locator(".chip[data-status=\"all\"]").click();
    await d.page.keyboard.press("d");
    await waitMode(d.page, "design");
    await d.page.keyboard.press("d");
    await waitMode(d.page, "use");
  } finally {
    await d.close();
  }
});

test("with Snap on, arrow steps always move and land on a grid line; moves are stored as whole pixels", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    for (const g of ["8", "12"]) {
      await d.page.locator("#grid-pitch").selectOption(g);
      if (!((await d.page.locator("#grid-lock").getAttribute("class")) || "").includes("is-on")) await d.page.locator("#grid-lock").click();
      await syncLayer(d.page);
      const G = Number(g);
      for (const sel of [".kpi:nth-child(1) .kpi-label", ".chip[data-status=\"overdue\"]"]) {
        await clickIn(d.page, d.frame, sel);
        let prev = (await rectOf(d.frame, sel)).y;
        for (let i = 0; i < 3; i++) {
          await d.page.keyboard.press("ArrowDown");
          await settle(d);
          const y = (await rectOf(d.frame, sel)).y;
          expect(y - prev, `${sel} step ${i} on ${G}`).toBeGreaterThanOrEqual(1);
          expect(y - prev).toBeLessThanOrEqual(G + 0.6);
          expect(nearLine(y, G), `${sel} at ${y} on ${G}`).toBeLessThanOrEqual(0.5);
          prev = y;
        }
      }
    }
    await clickIn(d.page, d.frame, "h1");
    await dragIn(d.page, d.frame, "h1", 23.4, 17.7, { steps: 7 });
    await settle(d);
    for (const c of readDoc(d.root).list) {
      expect(Number.isInteger(c.dx), JSON.stringify(c)).toBe(true);
      expect(Number.isInteger(c.dy), JSON.stringify(c)).toBe(true);
    }
  } finally {
    await d.close();
  }
});

test("a line break typed with Shift+Return shows on the page and comes off with Before", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    const sel = ".kpi:nth-child(1) .kpi-note";
    await clickIn(d.page, d.frame, sel);
    const h0 = (await rectOf(d.frame, sel)).h;
    const ws0 = await d.frame.evaluate((s) => getComputedStyle(document.querySelector(s)).whiteSpace, sel);
    await d.page.keyboard.press("e");
    await waitEditor(() => d.frame, true);
    await d.page.keyboard.press("ControlOrMeta+a");
    await d.page.keyboard.type("line one");
    await d.page.keyboard.press("Shift+Enter");
    await d.page.keyboard.type("line two");
    const n = await saves(d.page);
    await d.page.keyboard.press("Enter");
    await waitSaved(d.page, n);
    expect((await changeFor(d.root, d.frame, sel)).text_to).toBe("line one\nline two");
    expect((await rectOf(d.frame, sel)).h).toBeGreaterThan(h0 * 1.6);
    expect(await d.frame.evaluate((s) => document.querySelector(s).innerText, sel)).toBe("line one\nline two");
    await d.page.locator("[data-set-view=\"before\"]").click();
    await expect(d.page.locator("#before-note")).toBeVisible();
    await expect.poll(() => d.frame.evaluate((s) => getComputedStyle(document.querySelector(s)).whiteSpace, sel)).toBe(ws0);
    expect((await rectOf(d.frame, sel)).h).toBeCloseTo(h0, 0);
  } finally {
    await d.close();
  }
});

test("pressing Before while the text editor is open keeps what was typed", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    const sel = ".kpi:nth-child(2) .kpi-label";
    await clickIn(d.page, d.frame, sel);
    await d.page.keyboard.press("e");
    await waitEditor(() => d.frame, true);
    await d.page.keyboard.press("ControlOrMeta+a");
    await d.page.keyboard.type("Recurring revenue extra");
    await d.page.locator("[data-set-view=\"before\"]").click();
    await expect(d.page.locator("#before-note")).toBeVisible();
    await expect(d.page.locator("#before-note")).toContainText("1 edit.");
    expect((await changeFor(d.root, d.frame, sel)).text_to).toBe("Recurring revenue extra");
    await d.page.locator("[data-set-view=\"after\"]").click();
    await expect.poll(() => d.frame.evaluate((s) => document.querySelector(s).textContent, sel)).toBe("Recurring revenue extra");
  } finally {
    await d.close();
  }
});

test("editing the whole text of an element whose words were split", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    // No word carries a change: the words are merged back and the edit applies.
    const w = await wordRect(d.frame, ".subtitle", "Every");
    const g = await geometry(d.page);
    const p = toWindow(g, w.x + w.w / 2, w.y + w.h / 2);
    await d.page.mouse.dblclick(p.x, p.y);
    await expect(d.page.locator("#picked")).toContainText("a single word of a text");
    await d.page.keyboard.press("p");
    await expect(d.page.locator("#picked dd").first()).toContainText("<p>");
    await d.page.keyboard.press("e");
    await waitEditor(() => d.frame, true);
    await d.page.keyboard.press("ControlOrMeta+a");
    await d.page.keyboard.type("A fresh subtitle");
    let n = await saves(d.page);
    await d.page.keyboard.press("Enter");
    await waitSaved(d.page, n);
    expect(await d.frame.evaluate(() => document.querySelectorAll(".subtitle [data-dftp-piece]").length)).toBe(0);
    expect(await d.frame.evaluate(() => document.querySelector(".subtitle").textContent.trim())).toBe("A fresh subtitle");
    const c = await changeFor(d.root, d.frame, ".subtitle");
    expect(c.text_from).toBe("Demo data. Every name and number is invented.");
    expect(c.text_to).toBe("A fresh subtitle");
    expect((await readDoc(d.root)).list.filter((x) => x.missing)).toHaveLength(0);

    // A moved word: the whole-text edit is refused instead.
    const sel = ".kpi:nth-child(2) .kpi-note";
    const lw = await wordRect(d.frame, sel, "last");
    const g2 = await geometry(d.page);
    const q = toWindow(g2, lw.x + lw.w / 2, lw.y + lw.h / 2);
    await d.page.mouse.dblclick(q.x, q.y);
    n = await saves(d.page);
    await dragFrom(d.page, g2, lw.x + lw.w / 2, lw.y + lw.h / 2, 0, 20);
    await waitSaved(d.page, n);
    await d.page.keyboard.press("p");
    await expect(d.page.locator("#picked dd").first()).toContainText("<p>");
    await d.page.keyboard.press("e");
    await expect(d.page.locator(".notice").last()).toContainText("has its own change");
    await waitEditor(() => d.frame, false);
  } finally {
    await d.close();
  }
});

test("the text editor stays next to its element when the page scrolls", async ({ browser }) => {
  const d = await openDesigner(browser, { flags: { debug: true } });
  try {
    const sel = ".kpi:nth-child(1) .kpi-value";
    await clickIn(d.page, d.frame, sel);
    await d.page.keyboard.press("e");
    await waitEditor(() => d.frame, true);
    const a = await d.frame.evaluate(() => window.__dftp.editorRect());
    const el0 = await rectOf(d.frame, sel);
    await d.frame.evaluate(() => window.scrollBy(0, 150));
    await expect.poll(async () => (await rectOf(d.frame, sel)).y).toBeLessThan(el0.y - 100);
    const el1 = await rectOf(d.frame, sel);
    await expect.poll(() => d.frame.evaluate(() => window.__dftp.editorRect().top)).toBeCloseTo(a.top + (el1.y - el0.y), 0);
  } finally {
    await d.close();
  }
});

test("resizing past the opposite edge stops at the size the element can really be drawn at", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    const sel = ".kpi:nth-child(2)";
    await clickIn(d.page, d.frame, sel, PAD);
    const r = await rectOf(d.frame, sel);
    const g = await geometry(d.page);
    await dragFrom(d.page, g, r.x + r.w, r.y + r.h / 2, -(r.w + 100), 0);
    await settle(d);
    const c = await changeFor(d.root, d.frame, sel);
    const now = await rectOf(d.frame, sel);
    const min = await d.frame.evaluate((s) => {
      const cs = getComputedStyle(document.querySelector(s));
      return ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"].reduce((t, k) => t + parseFloat(cs[k]), 0);
    }, sel);
    expect(c.w).toBeGreaterThanOrEqual(Math.ceil(min));
    expect(Math.abs(c.w - now.w)).toBeLessThanOrEqual(1);
    // The west grip past the east edge: the right edge stays where it was.
    const sel2 = ".kpi:nth-child(3)";
    await clickIn(d.page, d.frame, sel2, PAD);
    const r2 = await rectOf(d.frame, sel2);
    await dragFrom(d.page, g, r2.x, r2.y + r2.h / 2, r2.w + 100, 0);
    await settle(d);
    const c2 = await changeFor(d.root, d.frame, sel2);
    const now2 = await rectOf(d.frame, sel2);
    expect(Math.abs(c2.w - now2.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(now2.x + now2.w - (r2.x + r2.w))).toBeLessThanOrEqual(1.5);
  } finally {
    await d.close();
  }
});

test("Option/Alt-click climbs one level each time and stays on the outermost element", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    const sel = ".kpi:nth-child(1) .kpi-value";
    await clickIn(d.page, d.frame, sel);
    const first = d.page.locator("#picked dd").first();
    await expect(first).toContainText("<p>");
    for (const tag of ["<article>", "<section>", "<main>", "<main>", "<main>"]) {
      await clickIn(d.page, d.frame, sel, { modifiers: ["Alt"] });
      await expect(first).toContainText(tag);
    }
  } finally {
    await d.close();
  }
});

test("a change on a repeated row waits when a filter leaves another row alone; nothing is re-keyed", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    const row3 = "#rows tr.row:nth-child(3) .biz-name";
    expect(await d.frame.locator(row3).innerText()).toBe("Copperleaf Dental Studio");
    await clickIn(d.page, d.frame, row3);
    const n = await saves(d.page);
    await dragIn(d.page, d.frame, row3, 0, 30);
    await waitSaved(d.page, n);
    const before = readDoc(d.root).list[0];
    expect(before.key).toMatch(/#2$/);
    await setMode(d.page, "use");
    await d.frame.locator("#search").fill("Halcyon");
    await expect(d.frame.locator("#rows tr.row")).toHaveCount(1);
    await expect(d.page.locator("#change-list li.is-missing")).toHaveCount(1);
    expect(await translateOf(d.frame, "#rows tr.row .biz-name")).toBe("none");
    const after = readDoc(d.root).list[0];
    expect(after.key).toBe(before.key);
    expect(after.occ).toBe(before.occ);
    expect(after.was_loc).toBeUndefined();
    await d.frame.locator("#search").fill("");
    await expect(d.page.locator("#change-list li.is-missing")).toHaveCount(0);
    await expect.poll(() => translateOf(d.frame, row3)).toBe("0px 30px");
  } finally {
    await d.close();
  }
});
