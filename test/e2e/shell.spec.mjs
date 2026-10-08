// The designer window itself: the side panel, copy and download, the theme
// and mode controls, client-side route changes in the preview, and the bar
// shown when the preview holds something without the layer.

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { startApp } from "../helpers.mjs";
import {
  openDesigner, expect, clickIn, dragIn, saves, waitSaved, listIds, setMode, readDoc, waitLoaded, waitMode,
  rootWith, docPath, removeRoot, idle,
} from "./helpers.mjs";
import { DATA_NOTICE } from "../../client/core/spec.js";
import { validateDoc } from "../../client/core/schema.js";

async function moveHeading(d) {
  await clickIn(d.page, d.frame, "h1");
  const n = await saves(d.page);
  await dragIn(d.page, d.frame, "h1", 24, 8);
  await waitSaved(d.page, n);
}

const drawerOpen = (d) => d.page.locator("#side-panel").isVisible();

test("the drawer is open by default from 1280 px and toggles by button, close, \\ in the window and \\ in the page", async ({ browser }) => {
  const wide = await openDesigner(browser, { viewport: { width: 1280, height: 800 } });
  try {
    expect(await drawerOpen(wide)).toBe(true);
    await expect(wide.page.locator("#panel-toggle")).toHaveAttribute("aria-expanded", "true");
    const scaleOpen = await wide.page.locator("#fit-zoom").innerText();
    await wide.page.locator("#panel-toggle").click();
    expect(await drawerOpen(wide)).toBe(false);
    await expect(wide.page.locator("#panel-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(await wide.page.locator("#fit-zoom").innerText()).not.toBe(scaleOpen);
    await wide.page.locator("#panel-toggle").click();
    expect(await drawerOpen(wide)).toBe(true);
    await wide.page.locator("#panel-close").click();
    expect(await drawerOpen(wide)).toBe(false);
    await wide.page.locator(".ident").click();
    await wide.page.keyboard.press("\\");
    expect(await drawerOpen(wide)).toBe(true);
    // From inside the page, in either mode.
    await clickIn(wide.page, wide.frame, "h1");
    await wide.page.keyboard.press("\\");
    await expect.poll(() => drawerOpen(wide)).toBe(false);
    await setMode(wide.page, "use");
    await clickIn(wide.page, wide.frame, ".subtitle");
    await wide.page.keyboard.press("\\");
    await expect.poll(() => drawerOpen(wide)).toBe(true);
  } finally {
    await wide.close();
  }
  const narrow = await openDesigner(browser, { viewport: { width: 1200, height: 800 } });
  try {
    expect(await drawerOpen(narrow)).toBe(false);
    await expect(narrow.page.locator("#panel-count")).toHaveText("0");
    await moveHeading(narrow);
    await expect(narrow.page.locator("#panel-count")).toHaveText("1");
  } finally {
    await narrow.close();
  }
});

test("Copy, Copy all and Download give this page's text, CHANGES.md and the JSON file", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    await d.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: d.app.shellOrigin });
    await moveHeading(d);
    const [id] = await listIds(d.page);
    await d.page.locator("#copy-page").click();
    await expect(d.page.locator(".notice").last()).toContainText("Copied the edits for this page");
    const text = await d.page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain(DATA_NOTICE);
    expect(text).toContain(`[${id}] <h1> "Active Clients"`);
    expect(text).toContain("## Page \"active-clients\" — desktop (1440 px wide), light — 1 change");

    await d.page.locator("#copy-every").click();
    await expect(d.page.locator(".notice").last()).toContainText("Copied CHANGES.md");
    const md = await d.page.evaluate(() => navigator.clipboard.readText());
    expect(md.startsWith("# Layout changes\n")).toBe(true);
    expect(md).toContain(DATA_NOTICE);
    expect(md).toContain(`[${id}]`);

    const [download] = await Promise.all([d.page.waitForEvent("download"), d.page.locator("#save-file").click()]);
    expect(download.suggestedFilename()).toBe("dftp-active-clients-desktop.json");
    const file = await download.path();
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const v = validateDoc({ ...doc, rev: 0, writer: "", seq: 0 }, { page: "active-clients", device: "desktop" });
    expect(v.ok, v.error).toBe(true);
    expect(doc.list.map((c) => c.id)).toEqual([id]);
  } finally {
    await d.close();
  }
});

test("Light / Dark switches the page's theme; the next save records it", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    expect(await d.frame.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("light");
    await d.page.locator("button[data-set-theme=\"dark\"]").click();
    await expect.poll(() => d.frame.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
    await moveHeading(d);
    expect(readDoc(d.root).theme).toBe("dark");
    // The choice is remembered for the next load.
    await d.page.locator("#reload-page").click();
    await waitLoaded(d.page);
    await expect.poll(() => d.frame.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
  } finally {
    await d.close();
  }
});

test("Use mode leaves the page working; D switches back to Design", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    await d.page.locator(".ident").click();
    await d.page.keyboard.press("d");
    await waitMode(d.page, "use");
    await clickIn(d.page, d.frame, "#search");
    await d.page.keyboard.type("rentals");
    await expect.poll(() => d.frame.evaluate(() => document.querySelectorAll("tr.row").length)).toBe(2);
    await expect(d.page.locator("#picked")).toContainText("Switch to Design to pick an element");
    await d.page.locator(".ident").click();
    await d.page.keyboard.press("d");
    await waitMode(d.page, "design");
    await clickIn(d.page, d.frame, "h1");
    await expect(d.page.locator("#picked")).toContainText("Active Clients");
    expect(await d.frame.evaluate(() => document.documentElement.classList.contains("dftp-design"))).toBe(true);
  } finally {
    await d.close();
  }
});

test("a move to another address inside the page takes the changes off and offers the way back", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    await moveHeading(d);
    const posts = d.posts.length;
    await d.frame.evaluate(() => history.pushState({}, "", "/somewhere-else?tab=2"));
    await expect(d.page.locator("#away-note")).toBeVisible();
    await expect(d.page.locator("#away-msg")).toContainText("/somewhere-else?tab=2");
    await expect.poll(() => d.frame.evaluate(() => getComputedStyle(document.querySelector("h1")).translate)).toBe("none");
    await expect(d.page.locator("body")).toHaveAttribute("data-current-mode", "use");
    await d.page.locator("button[data-set-mode=\"design\"]").click();
    await expect(d.page.locator(".notice").last()).toContainText("Use the Back button above it before editing");
    expect(d.posts.length).toBe(posts);
    await d.page.locator("#away-return").click();
    await waitLoaded(d.page);
    await expect(d.page.locator("#away-note")).toBeHidden();
    await expect(d.page.locator("body")).toHaveAttribute("data-current-mode", "design");
    await expect.poll(() => d.frame.evaluate(() => getComputedStyle(document.querySelector("h1")).translate)).not.toBe("none");
    expect(await d.frame.evaluate(() => location.pathname)).toBe("/");
  } finally {
    await d.close();
  }
});

test("a frame that shows something without the layer gets the no-layer bar", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    await setMode(d.page, "use");
    await d.frame.evaluate(() => {
      location.href = "/not-a-page";
    });
    await expect(d.page.locator("#nolayer-note")).toBeVisible({ timeout: 8000 });
    await d.page.locator("#nolayer-retry").click();
    await waitLoaded(d.page);
    await expect(d.page.locator("#nolayer-note")).toBeHidden();
    expect(await d.frame.evaluate(() => location.pathname)).toBe("/");
  } finally {
    await d.close();
  }
});

test("a change file that cannot be read leaves the frame blank and says so", async ({ browser }) => {
  const root = await rootWith();
  fs.mkdirSync(path.join(root, ".dftp", "changes"), { recursive: true });
  fs.writeFileSync(docPath(root), "{ this is not json");
  const app = await startApp({ root, keepRoot: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.route(/^(?!http:\/\/127\.0\.0\.1[:/])[a-z]+:\/\//i, (route) => route.abort());
    const page = await context.newPage();
    const posts = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push(r.url());
    });
    await page.goto(app.link);
    await expect(page.locator("#save-status")).toContainText("could not be loaded");
    await expect(page.locator("#canvas")).toHaveAttribute("data-loaded", "0");
    expect(await page.locator("#page-frame").getAttribute("src")).toBeNull();
    await page.locator("#save-state").click();
    await page.waitForTimeout(300);
    expect(posts).toEqual([]);
    expect(fs.readFileSync(docPath(root), "utf8")).toBe("{ this is not json");
  } finally {
    await context.close();
    await app.close();
    await idle(app);
    await removeRoot(root);
  }
});

test("the change list: Find, Reset, Remove change and the two-step Reset page", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    await moveHeading(d);
    await clickIn(d.page, d.frame, ".kpi:nth-child(1)", { fx: 0.5, fy: 0.07 });
    let n = await saves(d.page);
    await d.page.keyboard.press("Delete");
    await waitSaved(d.page, n);
    expect((await listIds(d.page)).length).toBe(2);

    // Select puts the selection on the change's element.
    await d.page.locator("#change-list li").first().getByRole("button", { name: "Find" }).click();
    await expect(d.page.locator("#picked")).toContainText("Active Clients");
    await expect(d.page.locator("#picked")).toContainText("shifted 24 px right");
    // Remove change (in the Selected panel) takes that change off.
    n = await saves(d.page);
    await d.page.locator("#picked").getByRole("button", { name: "Remove change" }).click();
    await waitSaved(d.page, n);
    expect((await listIds(d.page)).length).toBe(1);
    expect(await d.frame.evaluate(() => getComputedStyle(document.querySelector("h1")).translate)).toBe("none");

    await moveHeading(d);
    expect((await listIds(d.page)).length).toBe(2);
    // Reset in the list.
    n = await saves(d.page);
    await d.page.locator("#change-list li").last().getByRole("button", { name: "Reset" }).click();
    await waitSaved(d.page, n);
    expect((await listIds(d.page)).length).toBe(1);

    // Reset page asks once more before it acts.
    await d.page.locator("#clear-page").click();
    await expect(d.page.locator("#clear-page")).toHaveText("Remove all 1?");
    expect((await listIds(d.page)).length).toBe(1);
    n = await saves(d.page);
    await d.page.locator("#clear-page").click();
    await waitSaved(d.page, n);
    expect(await listIds(d.page)).toEqual([]);
    expect(readDoc(d.root).list).toEqual([]);
    await expect(d.page.locator("#clear-page")).toBeDisabled();
    // ... and undo brings everything back.
    n = await saves(d.page);
    await d.page.locator("#undo-btn").click();
    await waitSaved(d.page, n);
    expect((await listIds(d.page)).length).toBe(1);
  } finally {
    await d.close();
  }
});
