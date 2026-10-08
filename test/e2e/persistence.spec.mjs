// Saved changes coming back: reload, relocation after the source changed
// (and waiting while it has not), saving before a device switch, two windows
// on one page, and the "done" command while the designer is open.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers.mjs";
import {
  openDesigner, openWindow, expect, clickIn, dragIn, readDoc, saves, waitSaved, waitLoaded, listIds,
  changeFor, translateOf, docPath, setDevice, removeRoot,
} from "./helpers.mjs";

const LONG_TEST_MS = 60000;

// Top padding of a button, away from its icon, its words and the handles.
const EDGE = { fx: 0.3, fy: 0.12 };

async function moveNewButton(d, dx = 30, dy = 12) {
  await clickIn(d.page, d.frame, "#new-btn", EDGE);
  const n = await saves(d.page);
  await dragIn(d.page, d.frame, "#new-btn", dx, dy, EDGE);
  await waitSaved(d.page, n);
}

// Wait until the saved change has its source fingerprint.
async function savedWithSource(d) {
  await expect.poll(() => {
    const doc = readDoc(d.root);
    return doc && doc.list.length === 1 && /^[0-9a-f]{12}$/.test(doc.list[0].src || "");
  }, { timeout: 8000 }).toBe(true);
  return readDoc(d.root).list[0];
}

test("changes come back after a reload and in a new window", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    await moveNewButton(d);
    const id = (await listIds(d.page))[0];
    const moved = await translateOf(d.frame, "#new-btn");
    expect(moved).not.toBe("none");
    await d.page.locator("#reload-page").click();
    await waitLoaded(d.page);
    await expect.poll(() => translateOf(d.frame, "#new-btn")).toBe(moved);
    expect(await listIds(d.page)).toEqual([id]);
    const w2 = await openWindow(browser, d.app);
    try {
      await expect.poll(() => translateOf(w2.frame, "#new-btn")).toBe(moved);
    } finally {
      await w2.context.close();
    }
  } finally {
    await d.close();
  }
});

test("after the source file changed, a change moves to its element's new line", async ({ browser }) => {
  const d = await openDesigner(browser, { keepRoot: true });
  try {
    await moveNewButton(d);
    const before = await savedWithSource(d);
    await d.context.close();
    // Two new lines near the top of the body: every later line moves down.
    const file = path.join(d.root, "demo", "active-clients.html");
    const src = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, src.replace("<body>\n", "<body>\n  <!-- an edit made after the change -->\n\n"));
    const w = await openWindow(browser, d.app);
    try {
      await expect.poll(() => {
        const doc = readDoc(d.root);
        return doc.list[0].loc;
      }, { timeout: 10000 }).not.toBe(before.loc);
      const after = readDoc(d.root).list[0];
      const [, l0] = /:(\d+):\d+$/.exec(before.loc);
      const [, l1] = /:(\d+):\d+$/.exec(after.loc);
      expect(Number(l1)).toBe(Number(l0) + 2);
      expect(after.was_loc).toBe(before.loc);
      expect(after.id).toBe(before.id);
      // The fingerprint stays the one the change was made against, so
      // CHANGES.md keeps saying that the file has changed since.
      expect(after.src).toBe(before.src);
      const md = fs.readFileSync(path.join(d.root, ".dftp", "CHANGES.md"), "utf8");
      expect(md).toContain("file edited since this change was recorded");
      await expect.poll(() => translateOf(w.frame, "#new-btn")).not.toBe("none");
    } finally {
      await w.context.close();
    }
  } finally {
    await d.close();
    await removeRoot(d.root);
  }
});

test("while the source is unchanged, a change whose element is not drawn waits instead of moving", async ({ browser }) => {
  const d = await openDesigner(browser, { keepRoot: true });
  try {
    await moveNewButton(d);
    const real = await savedWithSource(d);
    await d.context.close();
    // Point the change at a line that draws nothing now, as if its element
    // were in a closed panel; the button with the same words is elsewhere.
    const file = docPath(d.root);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const ghost = "demo/active-clients.html:9999:5";
    doc.list[0] = { ...doc.list[0], key: `${ghost}#0`, loc: ghost };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    let w = await openWindow(browser, d.app);
    try {
      await expect(w.page.locator("#change-list li.is-missing")).toHaveCount(1, { timeout: 8000 });
      await w.page.waitForTimeout(1500); // past the settle time
      expect(await translateOf(w.frame, "#new-btn")).toBe("none");
      expect(readDoc(d.root).list[0].loc).toBe(ghost);
    } finally {
      await w.context.close();
    }
    // Once the fingerprint says the source changed, it is looked for by its
    // tag and words, and moves.
    const doc2 = JSON.parse(fs.readFileSync(file, "utf8"));
    doc2.list[0].src = "000000000000";
    fs.writeFileSync(file, JSON.stringify(doc2, null, 2));
    w = await openWindow(browser, d.app);
    try {
      await expect.poll(() => readDoc(d.root).list[0].loc, { timeout: 10000 }).toBe(real.loc);
      expect(readDoc(d.root).list[0].was_loc).toBe(ghost);
      await expect.poll(() => translateOf(w.frame, "#new-btn")).not.toBe("none");
      await expect(w.page.locator("#change-list li.is-missing")).toHaveCount(0);
    } finally {
      await w.context.close();
    }
  } finally {
    await d.close();
    await removeRoot(d.root);
  }
});

test("a switch to another device stores the current device's edits first", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    await clickIn(d.page, d.frame, "h1");
    await dragIn(d.page, d.frame, "h1", 24, 0);
    // No wait for the save: the switch must save first.
    await setDevice(d.page, "phone");
    const desk = readDoc(d.root, "active-clients", "desktop");
    expect(desk && desk.list.length).toBe(1);
    expect(readDoc(d.root, "active-clients", "phone")).toBeNull();
    expect(await listIds(d.page)).toEqual([]);
    await expect(d.page.locator("[data-screen=\"phone\"]")).toHaveClass(/is-on/);
    await setDevice(d.page, "desktop");
    expect(await listIds(d.page)).toEqual([desk.list[0].id]);
  } finally {
    await d.close();
  }
});

test("two windows on one page: the later save gets a conflict and reloads", async ({ browser }) => {
  const a = await openDesigner(browser);
  const b = await openWindow(browser, a.app);
  try {
    await clickIn(a.page, a.frame, "h1");
    const n = await saves(a.page);
    await dragIn(a.page, a.frame, "h1", 20, 0);
    await waitSaved(a.page, n);
    const aId = (await listIds(a.page))[0];
    const conflict = b.page.waitForResponse((r) => r.url().endsWith("/api/changes") && r.request().method() === "POST" && r.status() === 409);
    await clickIn(b.page, b.frame, "#new-btn", EDGE);
    await dragIn(b.page, b.frame, "#new-btn", 20, 0, EDGE);
    await conflict;
    await expect(b.page.locator(".notice").last()).toContainText("stored newer edits for this page");
    await expect.poll(() => listIds(b.page)).toEqual([aId]);
    const doc = readDoc(a.root);
    expect(doc.list.map((c) => c.id)).toEqual([aId]);
  } finally {
    await b.context.close();
    await a.close();
  }
});

test("done removes changes while the designer is open; the designer reloads on its next save", async ({ browser }) => {
  test.setTimeout(LONG_TEST_MS);
  const d = await openDesigner(browser);
  try {
    await clickIn(d.page, d.frame, "h1");
    const n = await saves(d.page);
    await dragIn(d.page, d.frame, "h1", 20, 0);
    await waitSaved(d.page, n);
    const id = (await listIds(d.page))[0];
    const cli = runCli(["done", "--root", d.root, id]);
    const exit = await cli.exited;
    expect(exit.code, cli.err()).toBe(0);
    expect(cli.out()).toContain(`Removed 1 of 1 change(s): ${id}`);
    expect(readDoc(d.root).list).toEqual([]);
    const conflict = d.page.waitForResponse((r) => r.url().endsWith("/api/changes") && r.request().method() === "POST" && r.status() === 409);
    await clickIn(d.page, d.frame, "#new-btn", EDGE);
    await dragIn(d.page, d.frame, "#new-btn", 20, 0, EDGE);
    await conflict;
    await expect.poll(() => listIds(d.page)).toEqual([]);
    await waitLoaded(d.page);
    await expect.poll(() => translateOf(d.frame, "h1")).toBe("none");
    expect(await changeFor(d.root, d.frame, "h1")).toBeNull();
  } finally {
    await d.close();
  }
});

test("a change whose element is gone can be put on the selected element", async ({ browser }) => {
  const d = await openDesigner(browser, { keepRoot: true });
  try {
    await moveNewButton(d);
    await savedWithSource(d);
    await d.context.close();
    const file = docPath(d.root);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const ghost = "demo/active-clients.html:9999:5";
    doc.list[0] = { ...doc.list[0], key: `${ghost}#0`, loc: ghost };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const w = await openWindow(browser, d.app);
    try {
      await expect(w.page.locator("#change-list li.is-missing")).toHaveCount(1, { timeout: 8000 });
      await w.page.locator("#change-list li.is-missing").getByRole("button", { name: "Attach to selection" }).click();
      await expect(w.page.locator(".notice").last()).toContainText("Pick an element in the preview");
      await clickIn(w.page, w.frame, "#export-btn", EDGE);
      const n = await saves(w.page);
      await w.page.locator("#change-list li.is-missing").getByRole("button", { name: "Attach to selection" }).click();
      await waitSaved(w.page, n);
      await expect(w.page.locator("#change-list li.is-missing")).toHaveCount(0);
      const c = readDoc(d.root).list[0];
      expect(c.id).toBe(doc.list[0].id);
      expect(c.was_loc).toBe(ghost);
      expect(c.hint.id).toBe("export-btn");
      await expect.poll(() => translateOf(w.frame, "#export-btn")).not.toBe("none");
    } finally {
      await w.context.close();
    }
  } finally {
    await d.close();
    await removeRoot(d.root);
  }
});
