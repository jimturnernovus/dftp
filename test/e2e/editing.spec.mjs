// Editing in the designer on every built-in device: select, drag (snap off
// and on), the eight resize handles, nudging, hide, text and placeholder
// edits, split words, multi-select, parent selection, undo / redo.

import { test } from "@playwright/test";
import {
  openDesigner, expect, clickIn, dragIn, dragFrom, geometry, rectOf, toWindow, readDoc, saves, waitSaved,
  wordRect, changeFor, translateOf, waitEditor, syncLayer,
} from "./helpers.mjs";

const LONG_TEST_MS = 120000;

const NEAR = 2.5; // frame pixels lost to rounding when the page is scaled down
// A click picks the innermost element it hits, so a click meant for a
// container aims at the container's padding instead of a child.
const PAD = { fx: 0.5, fy: 0.07 };
// Top padding of a button, away from its icon, its words and the handles.
const EDGE = { fx: 0.3, fy: 0.12 };

function near(actual, expected, tol = NEAR) {
  expect(Math.abs(actual - expected), `${actual} should be within ${tol} of ${expected}`).toBeLessThanOrEqual(tol);
}

async function settle(d) {
  // Let the debounced save run, then wait for it.
  const n = await saves(d.page);
  await waitSaved(d.page, n);
}

for (const device of ["desktop", "tablet", "phone"]) {
  test.describe(`editing on ${device}`, () => {
    let d;
    test.beforeEach(async ({ browser }) => {
      d = await openDesigner(browser, { prefs: { device } });
      await expect(d.page.locator(`[data-screen="${device}"]`)).toHaveClass(/is-on/);
    });
    test.afterEach(async () => {
      await d.close();
    });

    test("select, then drag with snap off and on", async () => {
      await clickIn(d.page, d.frame, "h1");
      await expect(d.page.locator("#picked")).toContainText("Active Clients");
      await expect(d.page.locator("#picked")).toContainText("demo/active-clients.html:");
      const before = await rectOf(d.frame, "h1");
      let n = await saves(d.page);
      await dragIn(d.page, d.frame, "h1", 37, 23);
      await waitSaved(d.page, n);
      const after = await rectOf(d.frame, "h1");
      near(after.x - before.x, 37);
      near(after.y - before.y, 23);
      let c = await changeFor(d.root, d.frame, "h1", device);
      near(c.dx, 37);
      near(c.dy, 23);
      expect(c.tag).toBe("h1");
      expect(c.text).toBe("Active Clients");
      expect(c.id).toMatch(/^[a-z0-9]{8}$/);
      expect(c.ctx && c.ctx.parent).toBeTruthy();

      // Snap: the corner lands on a grid line.
      await d.page.locator("#grid-lock").click();
      await expect(d.page.locator("#grid-toggle")).toHaveClass(/is-on/);
      const G = Number(await d.page.locator("#grid-pitch").inputValue());
      await syncLayer(d.page);
      n = await saves(d.page);
      await dragIn(d.page, d.frame, "h1", 13, 9);
      await waitSaved(d.page, n);
      const snapped = await rectOf(d.frame, "h1");
      expect(Math.abs(snapped.x / G - Math.round(snapped.x / G)) * G).toBeLessThan(0.6);
      expect(Math.abs(snapped.y / G - Math.round(snapped.y / G)) * G).toBeLessThan(0.6);
      c = await changeFor(d.root, d.frame, "h1", device);
      near(before.x + c.dx, snapped.x, 0.6);
    });

    test("resize with each of the eight handles", async () => {
      // The heading starts its row and column, so its own size never moves it.
      const sel = "h1";
      await clickIn(d.page, d.frame, sel);
      // Directions chosen so the element never leaves the frame.
      const moves = {
        e: [-20, 0], w: [20, 0], s: [0, 20], n: [0, -20],
        se: [-20, -20], ne: [20, 20], nw: [-20, -20], sw: [20, -20],
      };
      for (const [dir, [dx, dy]] of Object.entries(moves)) {
        const r = await rectOf(d.frame, sel);
        const px = dir.includes("e") ? r.x + r.w : dir.includes("w") ? r.x : r.x + r.w / 2;
        const py = dir.includes("s") ? r.y + r.h : dir.includes("n") ? r.y : r.y + r.h / 2;
        const g = await geometry(d.page);
        const n = await saves(d.page);
        await dragFrom(d.page, g, px, py, dx, dy);
        await waitSaved(d.page, n);
        const a = await rectOf(d.frame, sel);
        const left = dir.includes("w") ? dx : 0;
        const right = dir.includes("e") ? dx : 0;
        const top = dir.includes("n") ? dy : 0;
        const bottom = dir.includes("s") ? dy : 0;
        near(a.x - r.x, left);
        near(a.x + a.w - (r.x + r.w), right);
        near(a.y - r.y, top);
        near(a.y + a.h - (r.y + r.h), bottom);
      }
      const c = await changeFor(d.root, d.frame, sel, device);
      const last = await rectOf(d.frame, sel);
      near(c.w, last.w, 0.6);
      near(c.h, last.h, 0.6);
    });

    test("nudge by 1, 10 and to the grid", async () => {
      await clickIn(d.page, d.frame, "h1");
      const r0 = await rectOf(d.frame, "h1");
      await d.page.keyboard.press("ArrowRight");
      await d.page.keyboard.press("Shift+ArrowDown");
      await settle(d);
      let c = await changeFor(d.root, d.frame, "h1", device);
      expect(c.dx).toBe(1);
      expect(c.dy).toBe(10);
      await d.page.locator("#grid-lock").click();
      const G = Number(await d.page.locator("#grid-pitch").inputValue());
      await syncLayer(d.page);
      await clickIn(d.page, d.frame, "h1");
      await d.page.keyboard.press("ArrowRight");
      await settle(d);
      const r1 = await rectOf(d.frame, "h1");
      expect(r1.x).toBeGreaterThan(r0.x + 1);
      expect(Math.abs(r1.x / G - Math.round(r1.x / G)) * G).toBeLessThan(0.6);
      c = await changeFor(d.root, d.frame, "h1", device);
      near(r0.x + c.dx, r1.x, 0.6);
    });

    test("hide with Delete", async () => {
      await clickIn(d.page, d.frame, "#export-btn", EDGE);
      await d.page.keyboard.press("Delete");
      await settle(d);
      expect(await d.frame.evaluate(() => getComputedStyle(document.querySelector("#export-btn")).display)).toBe("none");
      const c = await changeFor(d.root, d.frame, "#export-btn", device);
      expect(c.hidden).toBe(true);
      await expect(d.page.locator("#change-list")).toContainText("hidden");
      await d.page.locator("#change-list button", { hasText: "Show" }).click();
      await settle(d);
      expect(await d.frame.evaluate(() => getComputedStyle(document.querySelector("#export-btn")).display)).not.toBe("none");
    });

    test("edit a text and a placeholder", async () => {
      await clickIn(d.page, d.frame, "#export-btn", EDGE);
      await d.page.keyboard.press("e");
      await waitEditor(() => d.frame);
      await d.page.keyboard.type("Download list");
      await d.page.keyboard.press("Enter");
      await settle(d);
      await expect.poll(() => d.frame.evaluate(() => document.querySelector("#export-btn").textContent.trim())).toBe("Download list");
      let c = await changeFor(d.root, d.frame, "#export-btn", device);
      expect(c.text_from).toBe("Export CSV");
      expect(c.text_to).toBe("Download list");

      await clickIn(d.page, d.frame, "#search");
      await d.page.keyboard.press("Enter");
      await waitEditor(() => d.frame);
      await d.page.keyboard.type("Find a client");
      await d.page.keyboard.press("Enter");
      await settle(d);
      expect(await d.frame.evaluate(() => document.querySelector("#search").getAttribute("placeholder"))).toBe("Find a client");
      c = await changeFor(d.root, d.frame, "#search", device);
      expect(c.text_attr).toBe("placeholder");
      expect(c.text_to).toBe("Find a client");

      // Saving the original text again removes the text edit.
      await clickIn(d.page, d.frame, "#export-btn", EDGE);
      await d.page.keyboard.press("e");
      await waitEditor(() => d.frame);
      await d.page.keyboard.type("Export CSV");
      await d.page.keyboard.press("Enter");
      await settle(d);
      expect(await changeFor(d.root, d.frame, "#export-btn", device)).toBeNull();
    });

    test("split a text into words and move one", async () => {
      const w = await wordRect(d.frame, ".subtitle", "Every");
      const g = await geometry(d.page);
      const p = toWindow(g, w.x + w.w / 2, w.y + w.h / 2);
      await d.page.mouse.dblclick(p.x, p.y);
      await expect(d.page.locator("#picked")).toContainText("a single word of a text");
      await expect(d.page.locator("#picked")).toContainText("Every");
      const n = await saves(d.page);
      await dragFrom(d.page, g, w.x + w.w / 2, w.y + w.h / 2, 0, 30);
      await waitSaved(d.page, n);
      const doc = readDoc(d.root, "active-clients", device);
      const c = doc.list.find((x) => x.piece);
      expect(c).toBeTruthy();
      expect(c.key).toMatch(/>~0\.\d+$/);
      expect(c.text).toBe("Every");
      near(c.dy, 30);
      expect(await d.frame.evaluate(() => document.querySelectorAll(".subtitle [data-dftp-piece]").length)).toBe(8);
    });

    test("a split word's text edit stays put: no flicker, still there after a reload", async () => {
      const w = await wordRect(d.frame, ".subtitle", "number");
      const g = await geometry(d.page);
      const p = toWindow(g, w.x + w.w / 2, w.y + w.h / 2);
      await d.page.mouse.dblclick(p.x, p.y);
      await expect(d.page.locator("#picked")).toContainText("a single word of a text");
      await d.page.keyboard.press("e");
      await waitEditor(() => d.frame);
      const n = await saves(d.page);
      await d.page.keyboard.type("count");
      await d.page.keyboard.press("Enter");
      await waitSaved(d.page, n);
      const doc = readDoc(d.root, "active-clients", device);
      const c = doc.list.find((x) => x.piece);
      expect(c).toBeTruthy();
      expect(c.text).toBe("number");
      expect(c.text_to).toBe("count");
      // Watch the subtitle for a while: the edited word must read "count" every
      // time, and the page must stop changing (a redraw loop would keep
      // swapping the word back and forth).
      const watch = () => d.frame.evaluate(async () => {
        const sub = document.querySelector(".subtitle");
        let changes = 0;
        await new Promise((r) => setTimeout(r, 300));
        const mo = new MutationObserver((list) => { changes += list.length; for (const m of list) (window.__dftpTestMut ||= []).push(m.type + ":" + (m.attributeName || "") + ":" + (m.target.nodeName || "")); });
        mo.observe(sub, { subtree: true, childList: true, characterData: true, attributes: true });
        const seen = new Set();
        for (let i = 0; i < 15; i++) {
          seen.add(sub.textContent.replace(/\s+/g, " ").trim());
          await new Promise((r) => setTimeout(r, 100));
        }
        mo.disconnect();
        return { seen: [...seen], changes, what: window.__dftpTestMut || [] };
      });
      let r = await watch();
      expect(r.seen).toEqual(["Demo data. Every name and count is invented."]);
      expect(r.changes, JSON.stringify(r.what)).toBe(0);
      await d.page.locator("#reload-page").click();
      await expect(d.page.locator("#canvas")).toHaveAttribute("data-loaded", "1", { timeout: 15000 });
      await expect.poll(async () => d.frame.evaluate(() => document.querySelector(".subtitle").textContent.replace(/\s+/g, " ").trim())).toBe("Demo data. Every name and count is invented.");
      r = await watch();
      expect(r.seen).toEqual(["Demo data. Every name and count is invented."]);
      expect(r.changes, JSON.stringify(r.what)).toBe(0);
      await expect(d.page.locator("#change-list li.is-missing")).toHaveCount(0);
    });

    test("multi-select with Shift and Cmd: drag, reset and hide together", async () => {
      await clickIn(d.page, d.frame, ".kpi:nth-child(1)", PAD);
      await clickIn(d.page, d.frame, ".kpi:nth-child(2)", { ...PAD, modifiers: ["Shift"] });
      await clickIn(d.page, d.frame, ".kpi:nth-child(3)", { ...PAD, modifiers: ["Meta"] });
      await expect(d.page.locator("#picked")).toContainText("3 picked");
      let n = await saves(d.page);
      await dragIn(d.page, d.frame, ".kpi:nth-child(1)", 0, 24, PAD);
      await waitSaved(d.page, n);
      let doc = readDoc(d.root, "active-clients", device);
      expect(doc.list.length).toBe(3);
      for (const c of doc.list) near(c.dy, 24);
      n = await saves(d.page);
      await d.page.keyboard.press("r");
      await waitSaved(d.page, n);
      doc = readDoc(d.root, "active-clients", device);
      expect(doc.list.length).toBe(0);
      await clickIn(d.page, d.frame, ".kpi:nth-child(1)", PAD);
      await clickIn(d.page, d.frame, ".kpi:nth-child(4)", { ...PAD, modifiers: ["Shift"] });
      n = await saves(d.page);
      await d.page.keyboard.press("Delete");
      await waitSaved(d.page, n);
      doc = readDoc(d.root, "active-clients", device);
      expect(doc.list.filter((c) => c.hidden).length).toBe(2);
    });

    test("parent with P and with Option/Alt-click", async () => {
      await clickIn(d.page, d.frame, ".kpi:nth-child(1) .kpi-value");
      await expect(d.page.locator("#picked dd").first()).toContainText("<p>");
      await d.page.keyboard.press("p");
      await expect(d.page.locator("#picked dd").first()).toContainText("<article>");
      await clickIn(d.page, d.frame, ".kpi:nth-child(1) .kpi-value", { modifiers: ["Alt"] });
      await expect(d.page.locator("#picked dd").first()).toContainText("<section>");
    });

    test("undo and redo; quick nudges are one step", async () => {
      await clickIn(d.page, d.frame, "h1");
      for (let i = 0; i < 5; i++) await d.page.keyboard.press("ArrowRight");
      await settle(d);
      expect((await changeFor(d.root, d.frame, "h1", device)).dx).toBe(5);
      await expect(d.page.locator("#undo-btn")).toBeEnabled();
      let n = await saves(d.page);
      await d.page.locator("#undo-btn").click();
      await waitSaved(d.page, n);
      expect(await changeFor(d.root, d.frame, "h1", device)).toBeNull();
      await expect(d.page.locator("#undo-btn")).toBeDisabled();
      n = await saves(d.page);
      await d.page.locator("#redo-btn").click();
      await waitSaved(d.page, n);
      expect((await changeFor(d.root, d.frame, "h1", device)).dx).toBe(5);
      expect(await translateOf(d.frame, "h1")).toBe("5px");
    });
  });
}

// Text edits must settle: the element shows one text and the page stops
// changing. Samples the text and counts DOM mutations under a selector.
async function steady(frame, selector, ms = 1500) {
  return frame.evaluate(async ([sel, span]) => {
    const el = document.querySelector(sel);
    await new Promise((r) => setTimeout(r, 300));
    let changes = 0;
    const mo = new MutationObserver((list) => { changes += list.length; });
    mo.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    const seen = new Set();
    for (let t = 0; t < span; t += 100) {
      seen.add(el.textContent.replace(/\s+/g, " ").trim());
      await new Promise((r) => setTimeout(r, 100));
    }
    mo.disconnect();
    return { seen: [...seen], changes };
  }, [selector, ms]);
}

test.describe("text edits settle (desktop)", () => {
  let d;
  test.beforeEach(async ({ browser }) => {
    d = await openDesigner(browser);
  });
  test.afterEach(async () => {
    await d.close();
  });

  async function editText(selector, typed, { opts, clear = true } = {}) {
    await clickIn(d.page, d.frame, selector, opts);
    await d.page.keyboard.press("e");
    await waitEditor(() => d.frame);
    const n = await saves(d.page);
    if (clear) await d.page.keyboard.press("ControlOrMeta+a");
    if (clear) await d.page.keyboard.press("Backspace");
    if (typed) await d.page.keyboard.type(typed);
    await d.page.keyboard.press("Enter");
    await waitSaved(d.page, n);
  }

  test("double-click on a text that has a text edit: refused with a notice, no doubled text, no redraw loop", async () => {
    await editText(".subtitle", "Hello there friend");
    let r = await steady(d.frame, ".subtitle");
    expect(r.seen).toEqual(["Hello there friend"]);
    expect(r.changes).toBe(0);
    const w = await wordRect(d.frame, ".subtitle", "there");
    const g = await geometry(d.page);
    const p = toWindow(g, w.x + w.w / 2, w.y + w.h / 2);
    await d.page.mouse.dblclick(p.x, p.y);
    await expect(d.page.locator("#notices")).toContainText("This text has a text edit");
    r = await steady(d.frame, ".subtitle");
    expect(r.seen).toEqual(["Hello there friend"]);
    expect(r.changes).toBe(0);
    expect(await d.frame.evaluate(() => document.querySelectorAll(".subtitle [data-dftp-piece]").length)).toBe(0);
  });

  test("a text edited to nothing stays empty and is not marked missing", async () => {
    await editText("h1", "");
    const doc = readDoc(d.root);
    const c = doc.list.find((x) => x.text_to !== undefined && x.text_to !== null);
    expect(c && c.text_to).toBe("");
    expect(c.text).toBe("Active Clients");
    const r = await steady(d.frame, "h1");
    expect(r.seen).toEqual([""]);
    expect(r.changes).toBe(0);
    await expect(d.page.locator("#change-list li.is-missing")).toHaveCount(0);
    await d.page.locator("#reload-page").click();
    await expect(d.page.locator("#canvas")).toHaveAttribute("data-loaded", "1", { timeout: 15000 });
    await expect.poll(() => d.frame.evaluate(() => document.querySelector("h1").textContent.trim())).toBe("");
    expect((await steady(d.frame, "h1")).changes).toBe(0);
    await expect(d.page.locator("#change-list li.is-missing")).toHaveCount(0);
  });

  test("a word edit inside a moved element keeps the element's move", async () => {
    await clickIn(d.page, d.frame, ".subtitle");
    let n = await saves(d.page);
    await dragIn(d.page, d.frame, ".subtitle", 0, 30);
    await waitSaved(d.page, n);
    const w = await wordRect(d.frame, ".subtitle", "number");
    const g = await geometry(d.page);
    const p = toWindow(g, w.x + w.w / 2, w.y + w.h / 2);
    await d.page.mouse.dblclick(p.x, p.y);
    await expect(d.page.locator("#picked")).toContainText("a single word of a text");
    await d.page.keyboard.press("e");
    await waitEditor(() => d.frame);
    n = await saves(d.page);
    await d.page.keyboard.type("count");
    await d.page.keyboard.press("Enter");
    await waitSaved(d.page, n);
    const r = await steady(d.frame, ".subtitle");
    expect(r.seen).toEqual(["Demo data. Every name and count is invented."]);
    expect(r.changes).toBe(0);
    expect(await translateOf(d.frame, ".subtitle")).toBe("0px 30px");
    await expect(d.page.locator("#change-list li.is-missing")).toHaveCount(0);
    const doc = readDoc(d.root);
    expect(doc.list.filter((c) => c.missing).length).toBe(0);
    expect(doc.list.find((c) => !c.piece).text).toBe("Demo data. Every name and number is invented.");
  });

  test("a word longer than 80 characters (a long address) can be split out and edited", async () => {
    const long = "https://docs.example.test/clients/active/reports/2026/october/summary-of-every-invented-client.html";
    await d.frame.evaluate((u) => {
      const t = [...document.querySelector(".subtitle").childNodes].find((n) => n.nodeType === 3);
      t.nodeValue = t.nodeValue.replace("number", u);
    }, long);
    const w = await wordRect(d.frame, ".subtitle", long);
    const g = await geometry(d.page);
    const p = toWindow(g, w.x + Math.min(w.w / 2, 40), w.y + w.h / 2);
    await d.page.mouse.dblclick(p.x, p.y);
    await expect(d.page.locator("#picked")).toContainText("a single word of a text");
    await d.page.keyboard.press("e");
    await waitEditor(() => d.frame);
    const n = await saves(d.page);
    await d.page.keyboard.press("ControlOrMeta+a");
    await d.page.keyboard.type("the docs");
    await d.page.keyboard.press("Enter");
    await waitSaved(d.page, n);
    const r = await steady(d.frame, ".subtitle");
    expect(r.seen).toEqual(["Demo data. Every name and the docs is invented."]);
    expect(r.changes).toBe(0);
    await expect(d.page.locator("#change-list li.is-missing")).toHaveCount(0);
  });

  test("a two-line word edit keeps one space after it, not the source's line break", async () => {
    const w = await wordRect(d.frame, ".subtitle", "data.");
    const g = await geometry(d.page);
    const p = toWindow(g, w.x + w.w / 2, w.y + w.h / 2);
    await d.page.mouse.dblclick(p.x, p.y);
    await expect(d.page.locator("#picked")).toContainText("a single word of a text");
    await d.page.keyboard.press("e");
    await waitEditor(() => d.frame);
    const n = await saves(d.page);
    await d.page.keyboard.press("ControlOrMeta+a");
    await d.page.keyboard.type("aa");
    await d.page.keyboard.press("Shift+Enter");
    await d.page.keyboard.type("bb");
    await d.page.keyboard.press("Enter");
    await waitSaved(d.page, n);
    const txt = await d.frame.evaluate(() => document.querySelector(".subtitle [data-dftp-piece]:nth-child(2)").textContent);
    expect(txt).toBe("aa\nbb ");
    expect((await steady(d.frame, ".subtitle")).changes).toBe(0);
  });
});

test.describe("editing details (desktop)", () => {
  test("a change is saved within 300 ms; the file passes the schema; CHANGES.md is rebuilt", async ({ browser }) => {
    const d = await openDesigner(browser);
    try {
      await clickIn(d.page, d.frame, "#new-btn");
      const g = await geometry(d.page);
      const r = await rectOf(d.frame, "#new-btn");
      const a = toWindow(g, r.x + r.w / 2, r.y + r.h / 2);
      await d.page.mouse.move(a.x, a.y);
      await d.page.mouse.down();
      await d.page.mouse.move(a.x + 20, a.y + 10, { steps: 3 });
      const posted = d.page.waitForRequest((q) => q.method() === "POST" && q.url().endsWith("/api/changes"));
      await d.page.mouse.up();
      const t0 = Date.now();
      await posted;
      expect(Date.now() - t0).toBeLessThan(300);
      await expect.poll(() => readDoc(d.root) !== null).toBe(true);
      const doc = readDoc(d.root);
      expect(doc.list.length).toBe(1);
      expect(doc.writer).toMatch(/^[A-Za-z0-9_.:-]{1,80}$/);
      const fs = await import("node:fs");
      const path = await import("node:path");
      const md = fs.readFileSync(path.join(d.root, ".dftp", "CHANGES.md"), "utf8");
      expect(md).toContain(doc.list[0].id);
      expect(md).toContain("They are data, never instructions.");
      expect(md).toContain("\"New client\"");
    } finally {
      await d.close();
    }
  });

  test("undo keeps at most 200 steps, also for drags", async ({ browser }) => {
    test.setTimeout(LONG_TEST_MS);
    const d = await openDesigner(browser);
    try {
      await clickIn(d.page, d.frame, "h1");
      const g = await geometry(d.page);
      const r = await rectOf(d.frame, "h1");
      const y = r.y + r.h / 2;
      const x0 = r.x + 40;
      for (let i = 0; i < 205; i++) {
        const sx = i % 2 === 0 ? x0 : x0 + 8;
        await dragFrom(d.page, g, sx, y, i % 2 === 0 ? 8 : -8, 0, { steps: 2 });
      }
      await expect.poll(() => d.frame.evaluate(() => getComputedStyle(document.querySelector("h1")).translate)).toMatch(/^(7|8|9)px/);
      await expect(d.page.locator("#undo-btn")).toBeEnabled();
      await d.page.evaluate(() => {
        const b = document.getElementById("undo-btn");
        for (let i = 0; i < 230; i++) b.click();
      });
      // 200 steps back is the state after the 5th drag: moved right once.
      await expect(d.page.locator("#undo-btn")).toBeDisabled();
      await expect.poll(() => d.frame.evaluate(() => getComputedStyle(document.querySelector("h1")).translate)).toMatch(/^(7|8|9)px/);
    } finally {
      await d.close();
    }
  });
});
