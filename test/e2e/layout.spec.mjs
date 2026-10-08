// Layout of the designer window (notice bars, key hints) and of the demo
// page at phone and tablet widths.

import { test } from "@playwright/test";
import { openDesigner, expect, clickIn, saves, waitSaved, setMode } from "./helpers.mjs";

test("the Before bar sits above the preview and never covers the page", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    const frameTop0 = (await d.page.locator("#page-frame").boundingBox()).y;
    await clickIn(d.page, d.frame, "h1");
    const n = await saves(d.page);
    await d.page.keyboard.press("ArrowDown");
    await waitSaved(d.page, n);
    await d.page.locator("[data-set-view=\"before\"]").click();
    await expect(d.page.locator("#before-note")).toBeVisible();
    const note = await d.page.locator("#before-note").boundingBox();
    const frame = await d.page.locator("#page-frame").boundingBox();
    expect(note.y + note.height).toBeLessThanOrEqual(frame.y);
    expect(frame.y).toBeGreaterThan(frameTop0);
    // The page's own top bar is fully visible below the notice.
    const bar = await d.frame.evaluate(() => document.querySelector(".topbar").getBoundingClientRect().top);
    expect(bar).toBeGreaterThanOrEqual(0);
    await d.page.locator("[data-set-view=\"after\"]").click();
    await expect(d.page.locator("#before-note")).toBeHidden();
    await expect.poll(async () => (await d.page.locator("#page-frame").boundingBox()).y).toBeCloseTo(frameTop0, 0);
  } finally {
    await d.close();
  }
});

test("the key hints lead with B and \\, follow the mode, and are never cut off", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    const hints = d.page.locator("#key-hints");
    const fits = () => hints.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight + 1);
    await expect(hints).toBeVisible();
    let text = (await hints.innerText()).trim();
    expect(text.startsWith("B before / after")).toBe(true);
    expect(text).toContain("\\ panel");
    expect(text).toContain("D to Use");
    expect(await fits()).toBe(true);
    await setMode(d.page, "use");
    text = (await hints.innerText()).trim();
    expect(text).toContain("D back to Design");
    expect(text).not.toContain("grips resize");
    expect(await fits()).toBe(true);
    await setMode(d.page, "design");
    await clickIn(d.page, d.frame, "h1");
    const n = await saves(d.page);
    await d.page.keyboard.press("ArrowDown");
    await waitSaved(d.page, n);
    await d.page.locator("[data-set-view=\"before\"]").click();
    await expect(hints).toContainText("original page shown");
    expect(await fits()).toBe(true);
  } finally {
    await d.close();
  }
});

test("demo at phone width: one card line for the business and its menu, no contact line, the open card stands out", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    const p = await d.context.newPage();
    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(`${d.app.frameOrigin}/`);
    await expect(p.locator("#rows tr.row")).toHaveCount(12);
    const row = p.locator("#rows tr.row").first();
    const biz = await row.locator("td[data-label=\"Business\"]").boundingBox();
    const menu = await row.locator("td.actions").boundingBox();
    expect(Math.abs(biz.y - menu.y)).toBeLessThan(4);
    expect(menu.x).toBeGreaterThan(biz.x + biz.width - 1);
    expect(await row.locator("td.col-contact").evaluate((el) => getComputedStyle(el).display)).toBe("none");
    const closedBg = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    await row.locator(".biz-name").click();
    await expect(row).toHaveClass(/is-open/);
    expect(await row.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(closedBg);
    expect(await p.evaluate(() => document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth)).toBe(true);
    await p.close();
  } finally {
    await d.close();
  }
});

test("demo at tablet width does not scroll sideways", async ({ browser }) => {
  const d = await openDesigner(browser);
  try {
    const p = await d.context.newPage();
    for (const width of [820, 1024, 1440]) {
      await p.setViewportSize({ width, height: 1000 });
      await p.goto(`${d.app.frameOrigin}/`);
      await expect(p.locator("#rows tr.row")).toHaveCount(12);
      const sizes = await p.evaluate(() => [document.scrollingElement.scrollWidth, document.scrollingElement.clientWidth]);
      expect(sizes[0], `at ${width}`).toBeLessThanOrEqual(sizes[1]);
    }
    await p.close();
  } finally {
    await d.close();
  }
});
